FROM golang:${GO_VERSION}-bookworm

RUN apt-get update && apt-get install -y \
    curl git postgresql postgresql-client nginx supervisor \
    && rm -rf /var/lib/apt/lists/*

# Install Air for hot reload
RUN curl -fsSL https://raw.githubusercontent.com/air-verse/air/master/install.sh | sh

WORKDIR /app
EXPOSE ${BACKEND_PORT}
CMD ["air"]
