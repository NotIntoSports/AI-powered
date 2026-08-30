package config

import (
	"errors"
	"fmt"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"github.com/ai-interviewer/ai-powered/control-api/internal/secretbox"
)

const (
	defaultListenAddress     = "127.0.0.1:8080"
	defaultSessionTTL        = 8 * time.Hour
	minimumSessionTTL        = 15 * time.Minute
	maximumSessionTTL        = 30 * 24 * time.Hour
	defaultKnowledgeProvider = "local-pgvector"
	defaultEmbeddingBaseURL  = "http://127.0.0.1:8090"
	defaultEmbeddingModel    = "BAAI/bge-m3"
	defaultMCPListenAddress  = "127.0.0.1:8091"
)

var (
	ErrDatabaseURLRequired      = errors.New("DATABASE_URL is required")
	ErrSessionTTLRange          = errors.New("SESSION_TTL must be between 15m and 720h")
	ErrTrustedProxyCIDRs        = errors.New("TRUSTED_PROXY_CIDRS must contain valid CIDR prefixes")
	ErrSettingsMasterKey        = secretbox.ErrInvalidMasterKey
	ErrMCPAdminTokenRequired    = errors.New("MCP_ADMIN_TOKEN is required for the MCP service")
	ErrMCPActorUsernameRequired = errors.New("MCP_ACTOR_USERNAME is required for the MCP service")
)

type Config struct {
	ListenAddress     string
	DatabaseURL       string
	SessionTTL        time.Duration
	CookieSecure      bool
	TrustedProxyCIDRs []netip.Prefix
	SettingsMasterKey []byte
	KnowledgeProvider string
	EmbeddingBaseURL  string
	EmbeddingModel    string
	MCPListenAddress  string
	MCPAdminToken     string
	MCPActorUsername  string
	AgentInternalToken string
}

func Load(getenv func(string) string) (Config, error) {
	cfg := Config{
		ListenAddress:     defaultListenAddress,
		DatabaseURL:       getenv("DATABASE_URL"),
		SessionTTL:        defaultSessionTTL,
		CookieSecure:      true,
		KnowledgeProvider: defaultKnowledgeProvider,
		EmbeddingBaseURL:  defaultEmbeddingBaseURL,
		EmbeddingModel:    defaultEmbeddingModel,
		MCPListenAddress:  defaultMCPListenAddress,
	}
	if cfg.DatabaseURL == "" {
		return Config{}, ErrDatabaseURLRequired
	}

	if value := getenv("LISTEN_ADDRESS"); value != "" {
		cfg.ListenAddress = value
	}
	if value := getenv("SESSION_TTL"); value != "" {
		ttl, err := time.ParseDuration(value)
		if err != nil || ttl < minimumSessionTTL || ttl > maximumSessionTTL {
			return Config{}, fmt.Errorf("%w: %q", ErrSessionTTLRange, value)
		}
		cfg.SessionTTL = ttl
	}
	if value := getenv("COOKIE_SECURE"); value != "" {
		cookieSecure, err := strconv.ParseBool(value)
		if err != nil {
			return Config{}, fmt.Errorf("COOKIE_SECURE must be a boolean: %w", err)
		}
		cfg.CookieSecure = cookieSecure
	}
	if value := getenv("TRUSTED_PROXY_CIDRS"); value != "" {
		for _, rawPrefix := range strings.Split(value, ",") {
			prefix, err := netip.ParsePrefix(strings.TrimSpace(rawPrefix))
			if err != nil {
				return Config{}, fmt.Errorf("%w: %q", ErrTrustedProxyCIDRs, rawPrefix)
			}
			cfg.TrustedProxyCIDRs = append(cfg.TrustedProxyCIDRs, prefix.Masked())
		}
	}
	if value := getenv("SETTINGS_MASTER_KEY"); value != "" {
		key, err := secretbox.ParseMasterKey(value)
		if err != nil {
			return Config{}, err
		}
		cfg.SettingsMasterKey = key
	}
	if value := strings.TrimSpace(getenv("KNOWLEDGE_PROVIDER")); value != "" {
		cfg.KnowledgeProvider = value
	}
	if value := strings.TrimSpace(getenv("EMBEDDING_BASE_URL")); value != "" {
		cfg.EmbeddingBaseURL = strings.TrimRight(value, "/")
	}
	if value := strings.TrimSpace(getenv("EMBEDDING_MODEL")); value != "" {
		cfg.EmbeddingModel = value
	}
	if value := strings.TrimSpace(getenv("MCP_LISTEN_ADDRESS")); value != "" {
		cfg.MCPListenAddress = value
	}
	cfg.MCPAdminToken = strings.TrimSpace(getenv("MCP_ADMIN_TOKEN"))
	cfg.MCPActorUsername = strings.TrimSpace(getenv("MCP_ACTOR_USERNAME"))
	cfg.AgentInternalToken = strings.TrimSpace(getenv("AGENT_INTERNAL_TOKEN"))

	return cfg, nil
}
