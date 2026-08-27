package httpapi_test

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/yazdanctx/pomodorus/server/internal/apitest"
)

// maxCategories mirrors the server's ceiling on live tasks per account. It is
// written out rather than exported from the handler so that a test asserting
// about the ceiling is not agreeing with whatever the ceiling happens to be.
const maxCategories = 100

type category struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	IsPublic bool   `json:"isPublic"`
}

// signedIn returns a client that has an address and a handle, which is what
// everything past this point assumes.
func signedIn(t *testing.T, h *apitest.Harness) *apitest.Client {
	t.Helper()
	client := h.SignIn(address)
	claim(client, "yazdan").ExpectStatus(http.StatusOK)
	return client
}

func createCategory(c *apitest.Client, name string, isPublic bool) *apitest.Response {
	return c.POST("/api/categories", map[string]any{
		"id": uuid.NewString(), "name": name, "isPublic": isPublic,
	})
}

func categories(t *testing.T, c *apitest.Client) []category {
	t.Helper()
	var body struct {
		Categories []category `json:"categories"`
	}
	c.GET("/api/categories").ExpectStatus(http.StatusOK).JSON(&body)
	return body.Categories
}

func createdCategory(t *testing.T, res *apitest.Response) category {
	t.Helper()
	var body struct {
		Category category `json:"category"`
	}
	res.ExpectStatus(http.StatusOK).JSON(&body)
	return body.Category
}

func TestCategoriesStartEmpty(t *testing.T) {
	h := apitest.New(t)
	client := signedIn(t, h)

	// An empty array rather than null: the picker opens straight into its
	// create form when there is nothing yet, and should not have to tell an
	// absent list from an empty one.
	var raw struct {
		Categories []category `json:"categories"`
	}
	client.GET("/api/categories").ExpectStatus(http.StatusOK).JSON(&raw)
	if raw.Categories == nil {
		t.Fatal("the list is null, want an empty array")
	}
	if len(raw.Categories) != 0 {
		t.Fatalf("a new account has %d categories, want none", len(raw.Categories))
	}
}

func TestCreatingACategory(t *testing.T) {
	h := apitest.New(t)
	client := signedIn(t, h)

	made := createdCategory(t, createCategory(client, "درس", true))
	if made.Name != "درس" || !made.IsPublic {
		t.Fatalf("created %+v", made)
	}

	list := categories(t, client)
	if len(list) != 1 || list[0].ID != made.ID {
		t.Fatalf("the list is %+v, want the one just created", list)
	}
}

func TestCreatingIsIdempotentOnTheClientMintedID(t *testing.T) {
	h := apitest.New(t)
	client := signedIn(t, h)

	// The same request twice, which is what a retry on a poor connection is.
	id := uuid.NewString()
	body := map[string]any{"id": id, "name": "درس", "isPublic": true}
	first := createdCategory(t, client.POST("/api/categories", body))
	second := createdCategory(t, client.POST("/api/categories", body))

	if first.ID != second.ID {
		t.Errorf("the retry made a different row: %s then %s", first.ID, second.ID)
	}
	if list := categories(t, client); len(list) != 1 {
		t.Errorf("the retry left %d categories, want 1", len(list))
	}
}

func TestRenaming(t *testing.T) {
	h := apitest.New(t)
	client := signedIn(t, h)
	made := createdCategory(t, createCategory(client, "درص", true))

	renamed := createdCategory(t, client.POST("/api/categories/"+made.ID, map[string]any{
		"name": "درس", "isPublic": true,
	}))

	if renamed.Name != "درس" {
		t.Errorf("name is %q, want درس", renamed.Name)
	}
	if list := categories(t, client); len(list) != 1 || list[0].Name != "درس" {
		t.Errorf("the list is %+v", list)
	}
}

func TestTogglingPublicAndPrivate(t *testing.T) {
	h := apitest.New(t)
	client := signedIn(t, h)
	made := createdCategory(t, createCategory(client, "درس", true))

	hidden := createdCategory(t, client.POST("/api/categories/"+made.ID, map[string]any{
		"name": "درس", "isPublic": false,
	}))
	if hidden.IsPublic {
		t.Error("still public after being made private")
	}

	shown := createdCategory(t, client.POST("/api/categories/"+made.ID, map[string]any{
		"name": "درس", "isPublic": true,
	}))
	if !shown.IsPublic {
		t.Error("still private after being made public")
	}
}

func TestDeletingIsATombstone(t *testing.T) {
	h := apitest.New(t)
	client := signedIn(t, h)
	made := createdCategory(t, createCategory(client, "درس", true))

	client.POST("/api/categories/"+made.ID+"/delete", nil).ExpectStatus(http.StatusNoContent)

	if list := categories(t, client); len(list) != 0 {
		t.Fatalf("the deleted category is still listed: %+v", list)
	}

	// The row survives with its name, which is what stops a tidy-up erasing
	// the focus time recorded against it. Read from the database directly,
	// because there is deliberately no API that returns a tombstone.
	var name string
	var deleted bool
	err := h.DB.QueryRow(t.Context(),
		`SELECT name, deleted_at IS NOT NULL FROM categories WHERE id = $1`, made.ID).
		Scan(&name, &deleted)
	if err != nil {
		t.Fatalf("the row was hard-deleted: %v", err)
	}
	if name != "درس" || !deleted {
		t.Errorf("row is name=%q deleted=%v, want the name kept and a tombstone", name, deleted)
	}
}

func TestDeletingTwiceIsNotAFailure(t *testing.T) {
	h := apitest.New(t)
	client := signedIn(t, h)
	made := createdCategory(t, createCategory(client, "درس", true))

	// The caller asked for a state, and the state is what it gets.
	client.POST("/api/categories/"+made.ID+"/delete", nil).ExpectStatus(http.StatusNoContent)
	client.POST("/api/categories/"+made.ID+"/delete", nil).ExpectStatus(http.StatusNoContent)
}

func TestADeletedCategoryCannotBeRenamedBackToLife(t *testing.T) {
	h := apitest.New(t)
	client := signedIn(t, h)
	made := createdCategory(t, createCategory(client, "درس", true))
	client.POST("/api/categories/"+made.ID+"/delete", nil).ExpectStatus(http.StatusNoContent)

	client.POST("/api/categories/"+made.ID, map[string]any{"name": "درس", "isPublic": true}).
		ExpectError(http.StatusNotFound, "category_not_found")
}

func TestAProfanePublicNameIsRefused(t *testing.T) {
	h := apitest.New(t)
	client := signedIn(t, h)

	createCategory(client, "کیر", true).
		ExpectError(http.StatusBadRequest, "category_name_profane")

	// …and on rename, not only on create.
	made := createdCategory(t, createCategory(client, "درس", true))
	client.POST("/api/categories/"+made.ID, map[string]any{"name": "کیر", "isPublic": true}).
		ExpectError(http.StatusBadRequest, "category_name_profane")

	if list := categories(t, client); len(list) != 1 || list[0].Name != "درس" {
		t.Errorf("a refused rename went through: %+v", list)
	}
}

func TestAPrivateNameIsNobodyElsesBusiness(t *testing.T) {
	h := apitest.New(t)
	client := signedIn(t, h)

	// The name never leaves its owner, so refusing a word only they will ever
	// read would be moralising at somebody about their own notes.
	made := createdCategory(t, createCategory(client, "کیر", false))

	// Making it public is the moment it becomes everybody's business.
	client.POST("/api/categories/"+made.ID, map[string]any{"name": "کیر", "isPublic": true}).
		ExpectError(http.StatusBadRequest, "category_name_profane")
}

func TestANameMustFitTheField(t *testing.T) {
	h := apitest.New(t)
	client := signedIn(t, h)

	createCategory(client, "", true).ExpectError(http.StatusBadRequest, "category_name_length")
	createCategory(client, "   ", true).ExpectError(http.StatusBadRequest, "category_name_length")
	createCategory(client, strings.Repeat("د", 41), true).
		ExpectError(http.StatusBadRequest, "category_name_length")

	// Forty Persian letters is forty characters, not forty bytes.
	createCategory(client, strings.Repeat("د", 40), true).ExpectStatus(http.StatusOK)
}

func TestACategoryIsNotVisibleToAnybodyElse(t *testing.T) {
	h := apitest.New(t)
	mine := signedIn(t, h)
	made := createdCategory(t, createCategory(mine, "درس", true))

	theirs := h.SignIn("someone@example.com")
	claim(theirs, "someone").ExpectStatus(http.StatusOK)

	if list := categories(t, theirs); len(list) != 0 {
		t.Fatalf("somebody else's categories are visible: %+v", list)
	}
	theirs.POST("/api/categories/"+made.ID, map[string]any{"name": "hijacked", "isPublic": true}).
		ExpectError(http.StatusNotFound, "category_not_found")
	theirs.POST("/api/categories/"+made.ID+"/delete", nil).ExpectStatus(http.StatusNoContent)

	if list := categories(t, mine); len(list) != 1 {
		t.Error("somebody else deleted my category")
	}
}

func TestCategoriesRequireBeingSignedIn(t *testing.T) {
	h := apitest.New(t)

	h.GET("/api/categories").ExpectError(http.StatusUnauthorized, "not_signed_in")
	createCategory(h.Client, "درس", true).ExpectError(http.StatusUnauthorized, "not_signed_in")
}

func TestATaskListHasACeiling(t *testing.T) {
	h := apitest.New(t)
	client := signedIn(t, h)

	// The id is minted by the client, so nothing but this stops one account
	// writing rows until the disk is full.
	for i := range maxCategories {
		// Spread across the clock, because writes are also rate limited per
		// account and a hundred of them in one instant is not what a person
		// does. What is under test here is the ceiling on how many tasks are
		// kept, not how fast they arrived.
		h.Clock.Advance(2 * time.Second)
		createCategory(client, fmt.Sprintf("تسک %d", i), false).ExpectStatus(http.StatusOK)
	}
	h.Clock.Advance(2 * time.Second)
	createCategory(client, "یکی زیادی", false).
		ExpectError(http.StatusConflict, "too_many_categories")

	// Tidying up makes room straight away. A tombstone is not a task, and a
	// ceiling that counted the ones already deleted would be a ceiling on how
	// many tasks somebody has ever had rather than on how many they keep.
	first := categories(t, client)[0]
	h.Clock.Advance(2 * time.Second)
	client.POST("/api/categories/"+first.ID+"/delete", nil).
		ExpectStatus(http.StatusNoContent)
	h.Clock.Advance(2 * time.Second)
	createCategory(client, "حالا جا هست", false).ExpectStatus(http.StatusOK)
}

func TestTheCeilingDoesNotBreakARetriedCreate(t *testing.T) {
	h := apitest.New(t)
	client := signedIn(t, h)

	var lastID string
	for i := range maxCategories {
		h.Clock.Advance(2 * time.Second)
		lastID = createdCategory(t, createCategory(client, fmt.Sprintf("تسک %d", i), false)).ID
	}

	// The account is full, and this is the request whose answer got lost on the
	// way back. It is not a new task, and refusing it would break the whole
	// reason the id is minted by the client.
	h.Clock.Advance(2 * time.Second)
	again := client.POST("/api/categories", map[string]any{
		"id": lastID, "name": fmt.Sprintf("تسک %d", maxCategories-1), "isPublic": false,
	})
	again.ExpectStatus(http.StatusOK)
	if got := createdCategory(t, again).ID; got != lastID {
		t.Errorf("the retry made a different row: %s, want %s", got, lastID)
	}
}
