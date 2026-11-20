ARG BUILD_FROM=ghcr.io/home-assistant/base:latest
FROM $BUILD_FROM

# Build arguments
ARG BUILD_ARCH
ARG BUILD_VERSION
ARG BUILD_DATE
ARG BUILD_REF

# Labels
LABEL \
    io.hass.name="Home Assistant Version Control" \
    io.hass.description="Git-powered version control for Home Assistant configuration" \
    io.hass.arch="${BUILD_ARCH}" \
    io.hass.type="app" \
    io.hass.version="${BUILD_VERSION}" \
    maintainer="saihgupr" \
    org.opencontainers.image.title="Home Assistant Version Control" \
    org.opencontainers.image.description="Git-powered version control for Home Assistant configuration" \
    org.opencontainers.image.vendor="Home Assistant Version Control" \
    org.opencontainers.image.authors="saihgupr" \
    org.opencontainers.image.licenses="MIT" \
    org.opencontainers.image.url="https://github.com/saihgupr/HomeAssistantVersionControl" \
    org.opencontainers.image.source="https://github.com/saihgupr/HomeAssistantVersionControl" \
    org.opencontainers.image.documentation="https://github.com/saihgupr/HomeAssistantVersionControl/blob/main/README.md" \
    org.opencontainers.image.created=${BUILD_DATE} \
    org.opencontainers.image.revision=${BUILD_REF} \
    org.opencontainers.image.version=${BUILD_VERSION}

ENV LANG C.UTF-8
ENV HOST=0.0.0.0

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
