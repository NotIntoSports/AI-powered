package livekittoken

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestSignProducesHS256JWTWithRoomGrant(t *testing.T) {
	now := time.Date(2026, 8, 16, 7, 0, 0, 0, time.UTC)
	token, expires, err := Sign("devkey", "devsecret", "bridge_1", "interview_1", time.Hour, now)
	if err != nil || expires.Sub(now) != time.Hour {
		t.Fatalf("token err=%v expires=%s", err, expires)
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("parts=%d", len(parts))
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(payload, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed["iss"] != "devkey" || parsed["sub"] != "bridge_1" {
		t.Fatalf("claims=%v", parsed)
	}
	video, _ := parsed["video"].(map[string]any)
	if video["room"] != "interview_1" || video["roomJoin"] != true {
		t.Fatalf("video=%v", video)
	}
}

func TestSignRejectsEmptyInputs(t *testing.T) {
	_, _, err := Sign("", "secret", "u", "r", time.Hour, time.Now())
	if err != ErrInvalid {
		t.Fatalf("err=%v", err)
	}
}
