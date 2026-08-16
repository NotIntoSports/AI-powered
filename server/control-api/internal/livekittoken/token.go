package livekittoken

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

var ErrInvalid = errors.New("invalid livekit token input")

type Grant struct {
	RoomJoin       bool `json:"roomJoin"`
	Room           string `json:"room,omitempty"`
	CanPublish     bool `json:"canPublish"`
	CanSubscribe   bool `json:"canSubscribe"`
	CanPublishData bool `json:"canPublishData"`
}

type claims struct {
	Issuer    string `json:"iss"`
	Subject   string `json:"sub"`
	NotBefore int64  `json:"nbf"`
	ExpiresAt int64  `json:"exp"`
	Video     Grant  `json:"video"`
}

func Sign(apiKey, apiSecret, identity, room string, ttl time.Duration, now time.Time) (string, time.Time, error) {
	apiKey = strings.TrimSpace(apiKey)
	apiSecret = strings.TrimSpace(apiSecret)
	identity = strings.TrimSpace(identity)
	room = strings.TrimSpace(room)
	if apiKey == "" || apiSecret == "" || identity == "" || room == "" || ttl <= 0 {
		return "", time.Time{}, ErrInvalid
	}
	expires := now.Add(ttl).UTC()
	payload, err := json.Marshal(claims{
		Issuer:    apiKey,
		Subject:   identity,
		NotBefore: now.Add(-time.Minute).UTC().Unix(),
		ExpiresAt: expires.Unix(),
		Video: Grant{
			RoomJoin:       true,
			Room:           room,
			CanPublish:     true,
			CanSubscribe:   true,
			CanPublishData: true,
		},
	})
	if err != nil {
		return "", time.Time{}, ErrInvalid
	}
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	body := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(apiSecret))
	_, _ = mac.Write([]byte(header + "." + body))
	signature := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return header + "." + body + "." + signature, expires, nil
}
