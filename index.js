const AWS = require("aws-sdk");
const { PubSub } = require("@google-cloud/pubsub");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const s3 = new AWS.S3();

// Set environment variables
const PROJECT_ID = process.env.PROJECT_ID;
const PUBSUB_TOPIC = process.env.PUBSUB_TOPIC;
const CLOUDFRONT_URL = process.env.CLOUDFRONT_URL;
const FFMPEG_PATH = "/opt/bin/ffmpeg";

// Temporary file paths
const TEMP_INPUT_FILE = "/tmp/input.mp4";
const TEMP_OUTPUT_DIR = "/tmp/output/";

// Function to sanitize the filename
function sanitizeFilename(filename) {
    return filename
        .replace(/[^A-Za-z0-9._]+/g, "-") // Replace spaces and special characters with "-"
        .replace(/-+/g, "-") // Replace multiple consecutive hyphens with a single hyphen
        .replace(/^-|-$|_$/g, ""); // Remove leading or trailing hyphens or underscores
}

// Authenticate Google Cloud Pub/Sub
function authenticateGCP() {
    try {
        const serviceKeyBase64 = process.env.GCP_SERVICE_KEY;
        if (!serviceKeyBase64) throw new Error("Environment variable GCP_SERVICE_KEY not set.");

        const serviceKeyJson = Buffer.from(serviceKeyBase64, "base64").toString("utf-8");
        const serviceKeyPath = "/tmp/gcp_service_key.json";

        fs.writeFileSync(serviceKeyPath, serviceKeyJson);
        process.env.GOOGLE_APPLICATION_CREDENTIALS = serviceKeyPath;

        console.log("Google Cloud authentication initialized.");
    } catch (error) {
        console.error("Error initializing Google Cloud authentication:", error.message);
        throw error;
    }
}

// Publish a message to Google Cloud Pub/Sub
async function publishToPubSub(projectId, topicId, message) {
    const pubSubClient = new PubSub({ projectId });
    const topic = pubSubClient.topic(topicId);

    try {
        const messageBuffer = Buffer.from(JSON.stringify(message));
        const messageId = await topic.publish(messageBuffer);
        console.log(`Message published to Pub/Sub: ${messageId}`);
    } catch (error) {
        console.error("Error publishing to Pub/Sub:", error.message);
        throw error;
    }
}

// Lambda handler
exports.handler = async (event) => {
    // Authenticate GCP
    authenticateGCP();

    // Extract S3 event details
    const record = event.Records[0];
    const sourceBucket = record.s3.bucket.name;
    const sourceKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    const targetBucket = sourceBucket;

    // Validate sourceKey format
    const sourceKeyPattern = /^source\/[^/]+\/[^/]+\.[^/]+$/;
    if (!sourceKeyPattern.test(sourceKey)) {
        throw new Error(`Invalid sourceKey format: ${sourceKey}. Expected format: source/uniqueKey/filename.extension`);
    }

    // Extract unique key and sanitize filename
    const keyParts = sourceKey.split("/");
    const uniqueKey = keyParts[1]; // Extract the unique key from the path
    const rawFilename = path.basename(sourceKey, path.extname(sourceKey));
    const baseFilename = sanitizeFilename(rawFilename);
    const targetPrefix = `hls/${uniqueKey}/${baseFilename}/`;

    console.log(`Source Bucket: ${sourceBucket}`);
    console.log(`Source Key: ${sourceKey}`);
    console.log(`Unique Key: ${uniqueKey}`);
    console.log(`Target Prefix: ${targetPrefix}`);

    try {
        // Download the MP4 file from S3
        const params = { Bucket: sourceBucket, Key: sourceKey };
        const data = await s3.getObject(params).promise();
        fs.writeFileSync(TEMP_INPUT_FILE, data.Body);
        console.log(`Downloaded file to ${TEMP_INPUT_FILE}, Size: ${data.Body.length} bytes`);

        // Ensure output directory exists
        if (!fs.existsSync(TEMP_OUTPUT_DIR)) {
            fs.mkdirSync(TEMP_OUTPUT_DIR);
        }

        // FFmpeg command
        const resolutions = [
            { name: "1080p", width: 1920, height: 1080, bitrate: "5000k" },
            { name: "720p", width: 1280, height: 720, bitrate: "3000k" },
            { name: "480p", width: 854, height: 480, bitrate: "1500k" },
        ];

        const playlists = [];
        for (const res of resolutions) {
            const playlist = path.join(TEMP_OUTPUT_DIR, `${res.name}.m3u8`);
            playlists.push({ name: res.name, bitrate: res.bitrate, playlist });

            try {
                const segmentFilename = path.join(TEMP_OUTPUT_DIR, `${res.name}_%03d.ts`);
                const command = `${FFMPEG_PATH} -i ${TEMP_INPUT_FILE} \
                    -vf "scale=w=trunc(iw*min(1\\,min(${res.width}/iw\\,${res.height}/ih))):h=trunc(ih*min(1\\,min(${res.width}/iw\\,${res.height}/ih))):force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2" \
                    -c:a aac -ar 48000 -b:a 128k \
                    -c:v h264 -profile:v main -preset veryslow -tune film -crf 23 \
                    -sc_threshold 0 -g 48 -keyint_min 48 \
                    -hls_time 4 -hls_playlist_type vod \
                    -b:v ${res.bitrate} -maxrate ${res.bitrate} -bufsize ${parseInt(res.bitrate) / 2} \
                    -hls_segment_filename ${segmentFilename} ${playlist}`;

                await new Promise((resolve, reject) => {
                    exec(command, (error, stdout, stderr) => {
                        if (error) {
                            console.error(`FFmpeg error for ${res.name}:`, stderr);
                            return reject(error);
                        }
                        console.log(`FFmpeg output for ${res.name}:`, stdout);
                        resolve();
                    });
                });

                console.log(`HLS conversion successful for ${res.name}`);
            } catch (error) {
                console.error(`Error during FFmpeg execution for ${res.name}:`, error.message);
                throw error;
            }
        }

        // Create the master playlist
        const masterPlaylistPath = path.join(TEMP_OUTPUT_DIR, "master.m3u8");
        const masterPlaylist = playlists
            .map(
                (res) =>
                    `#EXT-X-STREAM-INF:BANDWIDTH=${parseInt(res.bitrate, 10) * 1000},RESOLUTION=${res.width}x${res.height}\n${path.basename(
                        res.playlist
                    )}`
            )
            .join("\n");

        fs.writeFileSync(masterPlaylistPath, `#EXTM3U\n#EXT-X-VERSION:3\n${masterPlaylist}`);
        console.log("Master playlist created at", masterPlaylistPath);

        // Upload HLS files back to S3
        const files = fs.readdirSync(TEMP_OUTPUT_DIR);
        for (const file of files) {
            const filePath = path.join(TEMP_OUTPUT_DIR, file);
            const s3Key = path.join(targetPrefix, file);

            await s3
                .upload({
                    Bucket: targetBucket,
                    Key: s3Key,
                    Body: fs.createReadStream(filePath),
                })
                .promise();

            console.log(`Uploaded ${filePath} to s3://${targetBucket}/${s3Key}`);
        }

        // Publish response to Pub/Sub
        const response = {
            statusCode: 200,
            message: "MP4 successfully converted to HLS and uploaded",
            uniqueKey: uniqueKey,
            masterPlaylist: `${CLOUDFRONT_URL}/${uniqueKey}/${baseFilename}/master.m3u8`,
        };
        console.log(response, "response");
        await publishToPubSub(PROJECT_ID, PUBSUB_TOPIC, response);
        return response;
    } catch (error) {
        console.error("Error during processing:", error);
        throw error;
    } finally {
        // Clean up temporary files
        if (fs.existsSync(TEMP_INPUT_FILE)) {
            fs.unlinkSync(TEMP_INPUT_FILE);
        }
        if (fs.existsSync(TEMP_OUTPUT_DIR)) {
            fs.rmSync(TEMP_OUTPUT_DIR, { recursive: true, force: true });
        }
    }
};
