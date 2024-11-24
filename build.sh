#!/bin/bash
set -e  # Exit immediately if a command exits with a non-zero status

# Variables
PROJECT_DIR=$(pwd)
OUTPUT_FILE="lambda_function.zip"
BUILD_DIR="$PROJECT_DIR/build"
NODE_MODULES="$PROJECT_DIR/node_modules"
NODE_VERSION="18"  # Update to match the Node.js runtime version in your Lambda function

# Clean up previous builds
echo "Cleaning up previous builds..."
rm -rf "$BUILD_DIR" "$OUTPUT_FILE" "$NODE_MODULES"
mkdir -p "$BUILD_DIR"

# Verify that index.js exists
if [ ! -f "$PROJECT_DIR/index.js" ]; then
    echo "Error: index.js not found in $PROJECT_DIR"
    exit 1
fi

# Copy source code to build directory
echo "Copying source code to build directory..."
cp "$PROJECT_DIR/index.js" "$BUILD_DIR/"

# Create package.json if not present
if [ ! -f "$PROJECT_DIR/package.json" ]; then
    echo "Creating default package.json..."
    cat > "$PROJECT_DIR/package.json" <<EOL
{
    "name": "ffmpeg-converter",
    "version": "1.0.0",
    "description": "AWS Lambda function with FFmpeg and Pub/Sub",
    "main": "index.js",
    "dependencies": {
        "@google-cloud/pubsub": "^4.9.0",
        "aws-sdk": "^2.1692.0"
    }
}
EOL
fi

echo "Copying package.json to build directory..."
cp "$PROJECT_DIR/package.json" "$BUILD_DIR/"

# Use Podman/Docker to install Node.js dependencies in a Lambda-compatible environment
echo "Installing dependencies in a Lambda-compatible environment..."
podman run --rm --platform linux/amd64 \
    --entrypoint /bin/sh \
    -v "$PROJECT_DIR":/var/task \
    -w /var/task \
    public.ecr.aws/lambda/nodejs:$NODE_VERSION \
    -c "
    npm install --only=prod &&
    cp -R node_modules build/
    "

# Verify the build directory
if [ -z "$(ls -A $BUILD_DIR)" ]; then
    echo "Error: Build directory is empty! Dependency installation failed."
    exit 1
fi

# Create the deployment package
echo "Creating deployment package..."
cd "$BUILD_DIR"
zip -r "../$OUTPUT_FILE" .

# Clean up
cd "$PROJECT_DIR"
rm -rf "$BUILD_DIR" "$NODE_MODULES"

echo "Deployment package created: $OUTPUT_FILE"
