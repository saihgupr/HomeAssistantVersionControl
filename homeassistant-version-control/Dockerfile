ARG BUILD_FROM
FROM $BUILD_FROM

ENV LANG C.UTF-8

# Install Node.js and npm
RUN apk add --no-cache \
    git \
    openssh-client \
    ca-certificates \
    nodejs \
    npm \
    tzdata \
    && rm -rf /var/cache/apk/*

WORKDIR /usr/src/app

# Copy package files
COPY server.js package.json* ./

# Install Node.js dependencies
RUN npm install

# Copy application code
COPY . .

# Create non-root user and fix ownership
RUN addgroup -g 1001 -S havc && \
    adduser -S havc -G havc -h /usr/src/app && \
    chown -R havc:havc /usr/src/app && \
    git config --global --add safe.directory /usr/src/app && \
    git config --global --add safe.directory /config

# Note: Keep running as root because we need to write to /config
# which is mounted from the host and owned by root/homeassistant
# USER havc

# Expose port
EXPOSE 54001

# Start the application
CMD ["node", "server.js"]
