package settings

import (
	"context"
	"regexp"
	"strings"
	"time"

	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
	"github.com/jackc/pgx/v5"
)

var roleOrder = []string{"hr", "meeting_assistant", "interviewer", "candidate"}
var rolePlaceholders = regexp.MustCompile(`{{\s*([^{}]+?)\s*}}`)

type RoleProfile struct {
	Role            string    `json:"role"`
	OpeningTemplate string    `json:"openingTemplate"`
	ClosingTemplate string    `json:"closingTemplate"`
	Instructions    string    `json:"instructions"`
	ConfigVersion   int       `json:"configVersion"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

type RoleProfiles struct {
	Roles []RoleProfile `json:"roles"`
}
type RoleProfileInput struct {
	Role            string `json:"role"`
	OpeningTemplate string `json:"openingTemplate"`
	ClosingTemplate string `json:"closingTemplate"`
	Instructions    string `json:"instructions"`
}

func validRoleTemplate(value string) bool {
	value = strings.TrimSpace(value)
	if len([]rune(value)) < 1 || len([]rune(value)) > 500 {
		return false
	}
	for _, match := range rolePlaceholders.FindAllStringSubmatch(value, -1) {
		if match[1] != "target" && match[1] != "topic" {
			return false
		}
	}
	remainder := rolePlaceholders.ReplaceAllString(value, "")
	if strings.Contains(remainder, "{{") || strings.Contains(remainder, "}}") {
		return false
	}
	return true
}

func normalizeRoleInputs(inputs []RoleProfileInput) ([]RoleProfileInput, error) {
	if len(inputs) != len(roleOrder) {
		return nil, ErrInvalidInput
	}
	byRole := map[string]RoleProfileInput{}
	for _, input := range inputs {
		input.Role = strings.TrimSpace(input.Role)
		input.OpeningTemplate = strings.TrimSpace(input.OpeningTemplate)
		input.ClosingTemplate = strings.TrimSpace(input.ClosingTemplate)
		input.Instructions = strings.TrimSpace(input.Instructions)
		if _, exists := byRole[input.Role]; exists || !validRoleTemplate(input.OpeningTemplate) || !validRoleTemplate(input.ClosingTemplate) || len([]rune(input.Instructions)) < 1 || len([]rune(input.Instructions)) > 4000 {
			return nil, ErrInvalidInput
		}
		byRole[input.Role] = input
	}
	ordered := make([]RoleProfileInput, 0, len(roleOrder))
	for _, role := range roleOrder {
		input, ok := byRole[role]
		if !ok {
			return nil, ErrInvalidInput
		}
		ordered = append(ordered, input)
	}
	return ordered, nil
}

func (s *Service) GetRoles(ctx context.Context) (RoleProfiles, error) {
	rows, err := s.db.Query(ctx, `select role, opening_template, closing_template, instructions, config_version, updated_at from assistant_role_profiles order by case role when 'hr' then 1 when 'meeting_assistant' then 2 when 'interviewer' then 3 else 4 end`)
	if err != nil {
		return RoleProfiles{}, err
	}
	defer rows.Close()
	result := RoleProfiles{Roles: []RoleProfile{}}
	for rows.Next() {
		var profile RoleProfile
		if err := rows.Scan(&profile.Role, &profile.OpeningTemplate, &profile.ClosingTemplate, &profile.Instructions, &profile.ConfigVersion, &profile.UpdatedAt); err != nil {
			return RoleProfiles{}, err
		}
		result.Roles = append(result.Roles, profile)
	}
	return result, rows.Err()
}

func (s *Service) PutRoles(ctx context.Context, actor users.User, _ string, inputs []RoleProfileInput) (RoleProfiles, error) {
	normalized, err := normalizeRoleInputs(inputs)
	if err != nil {
		return RoleProfiles{}, err
	}
	err = pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		for _, input := range normalized {
			_, err := tx.Exec(ctx, `update assistant_role_profiles set opening_template=$2, closing_template=$3, instructions=$4, config_version=config_version+1, updated_by_user_id=$5, updated_at=now() where role=$1`, input.Role, input.OpeningTemplate, input.ClosingTemplate, input.Instructions, actor.ID)
			if err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return RoleProfiles{}, err
	}
	return s.GetRoles(ctx)
}
