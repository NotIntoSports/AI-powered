package ratelimit

import (
	"sync"
	"testing"
	"time"
)

func TestLoginLimiterAllowsTenAttemptBurstAndRefillsFivePerFiveMinutes(t *testing.T) {
	now := time.Date(2026, 8, 15, 0, 0, 0, 0, time.UTC)
	limiter := newLoginLimiter(func() time.Time { return now })

	for attempt := 1; attempt <= 10; attempt++ {
		if !limiter.Allow("admin", "192.0.2.10") {
			t.Fatalf("attempt %d denied, want initial burst of 10", attempt)
		}
	}
	if limiter.Allow("admin", "192.0.2.10") {
		t.Fatal("eleventh immediate attempt allowed")
	}

	now = now.Add(time.Minute)
	if !limiter.Allow("admin", "192.0.2.10") {
		t.Fatal("one token was not restored after one minute")
	}
	if limiter.Allow("admin", "192.0.2.10") {
		t.Fatal("more than one token was restored after one minute")
	}

	now = now.Add(4 * time.Minute)
	for attempt := 1; attempt <= 4; attempt++ {
		if !limiter.Allow("admin", "192.0.2.10") {
			t.Fatalf("refilled attempt %d denied", attempt)
		}
	}
	if limiter.Allow("admin", "192.0.2.10") {
		t.Fatal("more than five tokens were restored over five minutes")
	}
}

func TestLoginLimiterNormalizesUsernameAndSeparatesSourceIP(t *testing.T) {
	limiter := newLoginLimiter(func() time.Time {
		return time.Date(2026, 8, 15, 0, 0, 0, 0, time.UTC)
	})

	for attempt := 0; attempt < 10; attempt++ {
		if !limiter.Allow(" Admin ", "192.0.2.10") {
			t.Fatalf("attempt %d unexpectedly denied", attempt+1)
		}
	}
	if limiter.Allow("ADMIN", "192.0.2.10") {
		t.Fatal("case or surrounding whitespace bypassed the username bucket")
	}
	if !limiter.Allow("admin", "192.0.2.11") {
		t.Fatal("a different source IP did not receive an independent bucket")
	}
}

func TestLoginLimiterEvictsEntriesIdleForThirtyMinutes(t *testing.T) {
	now := time.Date(2026, 8, 15, 0, 0, 0, 0, time.UTC)
	limiter := newLoginLimiter(func() time.Time { return now })
	limiter.Allow("admin", "192.0.2.10")

	now = now.Add(30*time.Minute + time.Nanosecond)
	limiter.Allow("other", "192.0.2.11")

	if _, exists := limiter.entries["admin\x00"+"192.0.2.10"]; exists {
		t.Fatal("idle login bucket was not evicted")
	}
}

func TestLoginLimiterSupportsConcurrentAttempts(t *testing.T) {
	limiter := newLoginLimiter(time.Now)
	var wait sync.WaitGroup
	allowed := make(chan bool, 64)
	for attempt := 0; attempt < 64; attempt++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			allowed <- limiter.Allow("admin", "192.0.2.10")
		}()
	}
	wait.Wait()
	close(allowed)

	allowedCount := 0
	for result := range allowed {
		if result {
			allowedCount++
		}
	}
	if allowedCount != 10 {
		t.Fatalf("allowed=%d, want exactly 10", allowedCount)
	}
}
