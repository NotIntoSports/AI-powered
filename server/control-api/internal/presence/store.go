// Package presence reports active sessions, devices, and user online state.
package presence

import (
	"context"
	"time"

	"github.com/ai-interviewer/ai-powered/control-api/internal/database"
)

const OnlineWindow = 15 * time.Minute

type UserPresence struct {
	UserID             string
	LastSeenAt         *time.Time
	ActiveSessionCount int
	Online             bool
}

type Line struct {
	ID         string
	UserID     string
	Username   string
	Purpose    string
	DeviceID   string
	CreatedAt  time.Time
	ExpiresAt  time.Time
	LastUsedAt *time.Time
	Online     bool
}

type Device struct {
	ID            string
	UserID        string
	Username      string
	ClientVersion string
	OS            string
	OSVersion     string
	LastSeenAt    time.Time
	Disabled      bool
	Online        bool
}

type Store struct {
	db database.DBTX
}

func NewStore(db database.DBTX) *Store {
	return &Store{db: db}
}

func (s *Store) ListUserPresence(ctx context.Context) (map[string]UserPresence, error) {
	rows, err := s.db.Query(ctx, `
		select
			u.id,
			count(s.id) filter (
				where s.revoked_at is null and s.expires_at > now()
			)::int as active_sessions,
			max(coalesce(s.last_used_at, s.created_at)) filter (
				where s.revoked_at is null and s.expires_at > now()
			) as last_seen_at
		from users as u
		left join user_sessions as s on s.user_id = u.id
		group by u.id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	now := time.Now().UTC()
	out := map[string]UserPresence{}
	for rows.Next() {
		item := UserPresence{}
		if err := rows.Scan(&item.UserID, &item.ActiveSessionCount, &item.LastSeenAt); err != nil {
			return nil, err
		}
		item.Online = item.LastSeenAt != nil && now.Sub(*item.LastSeenAt) <= OnlineWindow
		out[item.UserID] = item
	}
	return out, rows.Err()
}

func (s *Store) ListLines(ctx context.Context) ([]Line, error) {
	rows, err := s.db.Query(ctx, `
		select
			s.id, s.user_id, u.username, s.purpose, coalesce(s.device_id, ''),
			s.created_at, s.expires_at, s.last_used_at
		from user_sessions as s
		join users as u on u.id = s.user_id
		where s.revoked_at is null and s.expires_at > now()
		order by coalesce(s.last_used_at, s.created_at) desc, s.id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	now := time.Now().UTC()
	lines := make([]Line, 0)
	for rows.Next() {
		line := Line{}
		if err := rows.Scan(
			&line.ID,
			&line.UserID,
			&line.Username,
			&line.Purpose,
			&line.DeviceID,
			&line.CreatedAt,
			&line.ExpiresAt,
			&line.LastUsedAt,
		); err != nil {
			return nil, err
		}
		last := line.CreatedAt
		if line.LastUsedAt != nil {
			last = *line.LastUsedAt
		}
		line.Online = now.Sub(last) <= OnlineWindow
		lines = append(lines, line)
	}
	return lines, rows.Err()
}

func (s *Store) ListDevices(ctx context.Context) ([]Device, error) {
	rows, err := s.db.Query(ctx, `
		select
			d.id, d.user_id, u.username, d.client_version, d.operating_system,
			d.os_version, d.last_seen_at, d.disabled_at is not null
		from devices as d
		join users as u on u.id = d.user_id
		order by d.last_seen_at desc, d.id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	now := time.Now().UTC()
	devices := make([]Device, 0)
	for rows.Next() {
		device := Device{}
		if err := rows.Scan(
			&device.ID,
			&device.UserID,
			&device.Username,
			&device.ClientVersion,
			&device.OS,
			&device.OSVersion,
			&device.LastSeenAt,
			&device.Disabled,
		); err != nil {
			return nil, err
		}
		device.Online = !device.Disabled && now.Sub(device.LastSeenAt) <= OnlineWindow
		devices = append(devices, device)
	}
	return devices, rows.Err()
}
