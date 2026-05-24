FROM golang:1.23-alpine AS builder

WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod tidy
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/payment-fault .

FROM alpine:3.20
WORKDIR /app
RUN apk add --no-cache curl netcat-openbsd
COPY --from=builder /out/payment-fault /app/payment-fault
EXPOSE 8081
ENTRYPOINT ["/app/payment-fault"]
