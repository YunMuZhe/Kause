# Stage 1: Build
FROM golang:1.21-alpine as builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o mcp-server .

# Stage 2: Runtime
# Use alpine to have sh/bash for debugging if needed, or distroless for security
FROM alpine:3.18

WORKDIR /app
COPY --from=builder /app/mcp-server .

# Install kubectl if you want to run kubectl commands directly (optional, since we use client-go)
# RUN apk add --no-cache kubectl

# Ensure kube config directory exists
RUN mkdir -p /root/.kube

CMD ["./mcp-server"]
