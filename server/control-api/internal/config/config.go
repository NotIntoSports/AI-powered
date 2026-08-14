package config

import (
	"errors"
	"fmt"
	"net/netip"
	"strconv"
	"strings"
	"time"
)

const (
	defaultListenAddress = "127.0.0.1:8080"
	defaultSessionTTL    = 8 * time.Hour
	minimumSessionTTL    = 15 * time.Minute
	maximumSessionTTL    = 30 * 24 * time.Hour
)

var (
	ErrDatabaseURLRequired = errors.New("DATABASE_URL is required")
	ErrSessionTTLRange     = errors.New("SESSION_TTL must be between 15m and 720h")
	ErrTrustedProxyCIDRs   = errors.New("TRUSTED_PROXY_CIDRS must contain valid CIDR prefixes")
)

type Config struct {
	ListenAddress     string
	DatabaseURL       string
	SessionTTL        time.Duration
	CookieSecure      bool
	TrustedProxyCIDRs []netip.Prefix
}

func Load(getenv func(string) string) (Config, error) {
	cfg := Config{
		ListenAddress: defaultListenAddress,
		DatabaseURL:   getenv("DATABASE_URL"),
		SessionTTL:    defaultSessionTTL,
		CookieSecure:  true,
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

	return cfg, nil
}
