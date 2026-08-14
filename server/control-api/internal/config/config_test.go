package config

import (
	"errors"
	"testing"
	"time"
)

func TestLoadRequiresDatabaseURL(t *testing.T) {
	_, err := Load(func(key string) string { return "" })
	if !errors.Is(err, ErrDatabaseURLRequired) {
		t.Fatalf("got %v", err)
	}
}

func TestLoadRejectsShortSessionTTL(t *testing.T) {
	env := map[string]string{"DATABASE_URL": "postgres://test", "SESSION_TTL": "5m"}
	_, err := Load(func(key string) string { return env[key] })
	if !errors.Is(err, ErrSessionTTLRange) {
		t.Fatalf("got %v", err)
	}
}

func TestLoadUsesDefaults(t *testing.T) {
	cfg, err := Load(func(key string) string {
		if key == "DATABASE_URL" {
			return "postgres://test"
		}
		return ""
	})
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.ListenAddress != "127.0.0.1:8080" {
		t.Errorf("ListenAddress = %q", cfg.ListenAddress)
	}
	if cfg.SessionTTL != 8*time.Hour {
		t.Errorf("SessionTTL = %s", cfg.SessionTTL)
	}
	if !cfg.CookieSecure {
		t.Error("CookieSecure = false")
	}
}

func TestLoadAcceptsConfiguredValuesAtMaximumTTL(t *testing.T) {
	env := map[string]string{
		"DATABASE_URL":   "postgres://test",
		"LISTEN_ADDRESS": "127.0.0.1:9090",
		"SESSION_TTL":    "720h",
		"COOKIE_SECURE":  "false",
	}
	cfg, err := Load(func(key string) string { return env[key] })
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.ListenAddress != "127.0.0.1:9090" {
		t.Errorf("ListenAddress = %q", cfg.ListenAddress)
	}
	if cfg.SessionTTL != 30*24*time.Hour {
		t.Errorf("SessionTTL = %s", cfg.SessionTTL)
	}
	if cfg.CookieSecure {
		t.Error("CookieSecure = true")
	}
}
