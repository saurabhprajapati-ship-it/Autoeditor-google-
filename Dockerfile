# Base image with Node.js 18 on Linux (Debian Bookworm for active package repositories)
FROM node:18-bookworm-slim

# Install system dependencies: Linux FFmpeg with libass & fontconfig for custom captions
RUN apt-get update && apt-get install -y \
    ffmpeg \
    fontconfig \
    fonts-dejavu \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy all project files into the container
COPY . .

# Ensure write permissions for app directory in container
RUN chmod -R 777 /app

# Environment variables for cloud container
ENV PORT=4000
ENV FFMPEG_PATH=ffmpeg
ENV CAPTION_FONT_PATH=/app/caption.ttf
ENV FRONTEND_DIR=/app/out

# Expose server port
EXPOSE 4000

# Start AutoEditor Node.js engine
CMD ["node", "bundle.cjs"]
