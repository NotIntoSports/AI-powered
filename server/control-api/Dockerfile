# syntax=docker/dockerfile:1

ARG RUNTIME_IMAGE=gcr.io/distroless/static-debian12:nonroot

FROM golang:1.26.5-alpine AS builder
WORKDIR /src
ARG GOPROXY=https://proxy.golang.org,direct
ENV GOPROXY=${GOPROXY}

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/control-api ./cmd/control-api \
	&& CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/control-api-admin ./cmd/control-api-admin \
	&& CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/control-api-mcp ./cmd/control-api-mcp

FROM ${RUNTIME_IMAGE}
LABEL org.opencontainers.image.source="https://github.com/NotIntoSports/AI-powered" \
	org.opencontainers.image.licenses="MIT" \
	org.opencontainers.image.title="control-api" \
	org.opencontainers.image.description="Private management API with no public registration"

COPY --from=builder /out/control-api /control-api
COPY --from=builder /out/control-api-admin /control-api-admin
COPY --from=builder /out/control-api-mcp /control-api-mcp

USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/control-api"]
