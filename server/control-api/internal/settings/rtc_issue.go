package settings

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/ai-interviewer/ai-powered/control-api/internal/livekittoken"
)

func (s *Service) IssueRTC(ctx context.Context, roomID, userID string) (RTCConnection, error) {
	if !rtcIDPattern(roomID) || !rtcIDPattern(userID) {
		return RTCConnection{}, ErrInvalidInput
	}
	store := NewStore(s.db, s.box)
	record, err := store.GetRTC(ctx)
	if errors.Is(err, ErrNotConfigured) {
		return RTCConnection{}, ErrNotConfigured
	}
	if err != nil {
		return RTCConnection{}, err
	}
	volcSecret, volcErr := store.DecryptSecret(record)
	livekitSecret, livekitErr := store.DecryptLiveKitSecret(record)
	public := PublicRTCFrom(record, volcErr, livekitErr)
	if !public.Enabled {
		return RTCConnection{}, ErrRTCUnavailable
	}
	provider := record.ActiveProvider
	if provider == "" {
		provider = ProviderVolcengine
	}
	if provider == ProviderLiveKit {
		if !public.LiveKitAvailable {
			return RTCConnection{}, ErrRTCUnavailable
		}
		token, expires, signErr := livekittoken.Sign(record.LiveKitAPIKey, livekitSecret, userID, roomID, livekitTokenTTL, time.Now().UTC())
		if signErr != nil {
			return RTCConnection{}, ErrRTCUnavailable
		}
		return RTCConnection{
			Provider:  ProviderLiveKit,
			Token:     token,
			URL:       record.LiveKitURL,
			RoomID:    roomID,
			UserID:    userID,
			Language:  record.Language,
			ExpiresAt: expires.Format(time.RFC3339),
		}, nil
	}
	if !public.VolcengineAvailable {
		return RTCConnection{}, ErrRTCUnavailable
	}
	if record.Mode == "trial" {
		return RTCConnection{
			Provider:  ProviderVolcengine,
			Token:     volcSecret,
			AppID:     record.AppID,
			RoomID:    record.TrialRoomID,
			UserID:    record.TrialUserID,
			Language:  record.Language,
			ExpiresAt: record.TrialExpiresAt.UTC().Format(time.RFC3339),
		}, nil
	}
	if record.TokenServiceURL == "" {
		return RTCConnection{}, ErrRTCUnavailable
	}
	token, expiresAt, err := s.fetchVolcengineToken(ctx, record, roomID, userID)
	if err != nil {
		return RTCConnection{}, err
	}
	return RTCConnection{
		Provider:  ProviderVolcengine,
		Token:     token,
		AppID:     record.AppID,
		RoomID:    roomID,
		UserID:    userID,
		Language:  record.Language,
		ExpiresAt: expiresAt,
	}, nil
}

func (s *Service) fetchVolcengineToken(ctx context.Context, record RTCRecord, roomID, userID string) (string, string, error) {
	client := s.client
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	body, _ := json.Marshal(map[string]string{
		"appId":  record.AppID,
		"roomId": roomID,
		"userId": userID,
	})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, record.TokenServiceURL, strings.NewReader(string(body)))
	if err != nil {
		return "", "", ErrRTCUnavailable
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return "", "", ErrRTCUnavailable
	}
	defer response.Body.Close()
	payload, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", "", ErrRTCUnavailable
	}
	var parsed struct {
		Token     string `json:"token"`
		ExpiresAt string `json:"expiresAt"`
	}
	if err := json.Unmarshal(payload, &parsed); err != nil || strings.TrimSpace(parsed.Token) == "" {
		return "", "", ErrRTCUnavailable
	}
	return parsed.Token, parsed.ExpiresAt, nil
}
