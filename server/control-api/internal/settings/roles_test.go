package settings

import (
	"errors"
	"testing"
)

func validRoleInputs() []RoleProfileInput {
	result := make([]RoleProfileInput, 0, len(roleOrder))
	for _, role := range roleOrder {
		result = append(result, RoleProfileInput{Role: role, OpeningTemplate: "你好 {{target}}，主题 {{topic}}", ClosingTemplate: "{{topic}} 到这里", Instructions: "保持角色主题"})
	}
	return result
}

func TestNormalizeRoleInputsRequiresExactlyFourRoles(t *testing.T) {
	_, err := normalizeRoleInputs(validRoleInputs()[:3])
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("expected invalid input, got %v", err)
	}
}

func TestNormalizeRoleInputsRejectsUnknownPlaceholder(t *testing.T) {
	input := validRoleInputs()
	input[0].OpeningTemplate = "{{secret}}"
	_, err := normalizeRoleInputs(input)
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("expected invalid input, got %v", err)
	}
}

func TestNormalizeRoleInputsOrdersProfiles(t *testing.T) {
	input := validRoleInputs()
	for left, right := 0, len(input)-1; left < right; left, right = left+1, right-1 {
		input[left], input[right] = input[right], input[left]
	}
	output, err := normalizeRoleInputs(input)
	if err != nil {
		t.Fatal(err)
	}
	for index, role := range roleOrder {
		if output[index].Role != role {
			t.Fatalf("role %d = %s", index, output[index].Role)
		}
	}
}
