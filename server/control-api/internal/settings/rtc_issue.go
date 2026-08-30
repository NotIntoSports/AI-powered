package settings

import (
	"context"
	"errors"
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
	livekitSecret, livekitErr := store.DecryptLiveKitSecret(record)
	public := PublicRTCFrom(record, livekitErr)
	if !public.Enabled || !public.Available {
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
