// Package ratelimit contains process-local abuse controls for authentication.
package ratelimit

import (
	"strings"
	"sync"
	"time"
)

const (
	loginBucketCapacity = 10
	loginRefillInterval = time.Minute
	loginEntryTTL       = 30 * time.Minute
	loginSweepInterval  = time.Minute
)

type loginBucket struct {
	tokens     float64
	lastRefill time.Time
	lastSeen   time.Time
}

// LoginLimiter limits each normalized username and canonical source IP pair.
// It is intentionally process-local; deployments with multiple API replicas
// must also enforce a shared limit at the trusted ingress layer.
type LoginLimiter struct {
	mu        sync.Mutex
	entries   map[string]*loginBucket
	now       func() time.Time
	lastSweep time.Time
}

// NewLoginLimiter creates a limiter with a burst of ten attempts and a refill
// rate of five attempts per five minutes.
func NewLoginLimiter() *LoginLimiter {
	return newLoginLimiter(time.Now)
}

func newLoginLimiter(now func() time.Time) *LoginLimiter {
	return &LoginLimiter{
		entries: make(map[string]*loginBucket),
		now:     now,
	}
}

// Allow consumes one login token for username and sourceIP.
func (l *LoginLimiter) Allow(username, sourceIP string) bool {
	if l == nil {
		return false
	}
	now := l.now()
	key := strings.ToLower(strings.TrimSpace(username)) + "\x00" + sourceIP

	l.mu.Lock()
	defer l.mu.Unlock()

	if l.lastSweep.IsZero() || now.Sub(l.lastSweep) >= loginSweepInterval {
		for existingKey, bucket := range l.entries {
			if now.Sub(bucket.lastSeen) > loginEntryTTL {
				delete(l.entries, existingKey)
			}
		}
		l.lastSweep = now
	}

	bucket, exists := l.entries[key]
	if !exists {
		bucket = &loginBucket{
			tokens:     loginBucketCapacity,
			lastRefill: now,
			lastSeen:   now,
		}
		l.entries[key] = bucket
	}

	elapsed := now.Sub(bucket.lastRefill)
	if elapsed > 0 {
		bucket.tokens += float64(elapsed) / float64(loginRefillInterval)
		if bucket.tokens > loginBucketCapacity {
			bucket.tokens = loginBucketCapacity
		}
		bucket.lastRefill = now
	}
	bucket.lastSeen = now
	if bucket.tokens < 1 {
		return false
	}
	bucket.tokens--
	return true
}
