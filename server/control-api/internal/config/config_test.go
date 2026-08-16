package config

import (
	"errors"
	"net/netip"
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
	if cfg.KnowledgeProvider != defaultKnowledgeProvider {
		t.Errorf("KnowledgeProvider = %q", cfg.KnowledgeProvider)
	}
	if cfg.EmbeddingBaseURL != defaultEmbeddingBaseURL {
		t.Errorf("EmbeddingBaseURL = %q", cfg.EmbeddingBaseURL)
	}
	if cfg.EmbeddingModel != defaultEmbeddingModel {
		t.Errorf("EmbeddingModel = %q", cfg.EmbeddingModel)
	}
}

func TestLoadAcceptsConfiguredValuesAtMaximumTTL(t *testing.T) {
	env := map[string]string{
		"DATABASE_URL":        "postgres://test",
		"LISTEN_ADDRESS":      "127.0.0.1:9090",
		"SESSION_TTL":         "720h",
		"COOKIE_SECURE":       "false",
		"TRUSTED_PROXY_CIDRS": "10.0.0.0/8, 2001:db8::/32",
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
	wantPrefixes := []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8"), netip.MustParsePrefix("2001:db8::/32")}
	if len(cfg.TrustedProxyCIDRs) != len(wantPrefixes) {
		t.Fatalf("TrustedProxyCIDRs=%v", cfg.TrustedProxyCIDRs)
	}
	for index := range wantPrefixes {
		if cfg.TrustedProxyCIDRs[index] != wantPrefixes[index] {
			t.Fatalf("TrustedProxyCIDRs[%d]=%v", index, cfg.TrustedProxyCIDRs[index])
		}
	}
}

func TestLoadAcceptsSettingsMasterKey(t *testing.T) {
	key := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	cfg, err := Load(func(keyName string) string {
		if keyName == "DATABASE_URL" {
			return "postgres://test"
		}
		if keyName == "SETTINGS_MASTER_KEY" {
			return key
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.SettingsMasterKey) != 32 {
		t.Fatalf("key length=%d", len(cfg.SettingsMasterKey))
	}
}

func TestLoadRejectsInvalidSettingsMasterKey(t *testing.T) {
	_, err := Load(func(keyName string) string {
		if keyName == "DATABASE_URL" {
			return "postgres://test"
		}
		if keyName == "SETTINGS_MASTER_KEY" {
			return "too-short"
		}
		return ""
	})
	if !errors.Is(err, ErrSettingsMasterKey) {
		t.Fatalf("error=%v", err)
	}
}

func TestLoadRejectsInvalidTrustedProxyCIDR(t *testing.T) {
	env := map[string]string{
		"DATABASE_URL":        "postgres://test",
		"TRUSTED_PROXY_CIDRS": "10.0.0.1,not-a-prefix",
	}
	_, err := Load(func(key string) string { return env[key] })
	if !errors.Is(err, ErrTrustedProxyCIDRs) {
		t.Fatalf("error=%v", err)
	}
}
