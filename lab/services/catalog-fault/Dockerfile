FROM golang:1.23-alpine AS builder

WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod tidy
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/catalog-fault .

FROM alpine:3.20
WORKDIR /app
RUN apk add --no-cache curl netcat-openbsd
COPY --from=builder /out/catalog-fault /app/catalog-fault
EXPOSE 8080
ENTRYPOINT ["/app/catalog-fault"]
