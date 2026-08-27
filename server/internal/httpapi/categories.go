package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/yazdanctx/pomodorus/server/internal/profanity"
	"github.com/yazdanctx/pomodorus/server/internal/store/db"
)

// What the picker's field allows, restated in the database as a CHECK.
const (
	categoryNameMin = 1
	categoryNameMax = 40
)

// maxCategoriesPerUser is how many live tasks one account may keep.
//
// Far past any real task list — the picker is a thing you scroll, and nobody
// scrolls a hundred of them — and finite because the id is minted by the
// client, so nothing but this stops one account writing rows until the disk
// is full.
//
// Refused rather than trimmed, which is the opposite of what the push
// subscriptions do, and for a reason: a subscription is an address a device
// hands over and can hand over again, while a task is something somebody wrote
// with a history recorded against it. The cheap thing to throw away is the
// address. Being told to tidy up is the right answer here, and deleting a task
// makes room immediately because tombstones are not counted.
const maxCategoriesPerUser = 100

// category is the shape the client reads. The tombstone never crosses the
// wire: a deleted category is simply not in the list.
type category struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	IsPublic bool   `json:"isPublic"`
}

type categoriesResponse struct {
	Categories []category `json:"categories"`
	ServerNow  int64      `json:"serverNow"`
}

type categoryResponse struct {
	Category  category `json:"category"`
	ServerNow int64    `json:"serverNow"`
}

func asCategory(row db.Category) category {
	return category{
		ID:       uuid.UUID(row.ID.Bytes).String(),
		Name:     row.Name,
		IsPublic: row.IsPublic,
	}
}

func (s *Server) listCategories(w http.ResponseWriter, r *http.Request) {
	user, ok := s.currentUser(r)
	if !ok {
		s.writeError(w, http.StatusUnauthorized, "not_signed_in")
		return
	}

	ctx, cancel := timeout(r, 5*time.Second)
	defer cancel()

	rows, err := s.q.LiveCategories(ctx, user.ID)
	if err != nil {
		s.log.Error("list categories", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}

	// An empty list is an empty array, never null: the picker opens straight
	// into its create form when there is nothing yet, and it should not have
	// to tell the two apart.
	out := make([]category, 0, len(rows))
	for _, row := range rows {
		out = append(out, asCategory(row))
	}
	writeJSON(w, http.StatusOK, categoriesResponse{Categories: out, ServerNow: s.now().UnixMilli()})
}

type createCategoryRequest struct {
	// Minted by the client, so a retry lands on the row the first attempt
	// created instead of making a second one.
	ID       string `json:"id"`
	Name     string `json:"name"`
	IsPublic bool   `json:"isPublic"`
}

func (s *Server) createCategory(w http.ResponseWriter, r *http.Request) {
	user, ok := s.currentUser(r)
	if !ok {
		s.writeError(w, http.StatusUnauthorized, "not_signed_in")
		return
	}

	if !s.spendWrite(w, user) {
		return
	}

	var body createCategoryRequest
	if err := readJSON(r, &body); err != nil {
		s.writeError(w, http.StatusBadRequest, "malformed_request")
		return
	}

	id, err := uuid.Parse(strings.TrimSpace(body.ID))
	if err != nil {
		s.writeError(w, http.StatusBadRequest, "malformed_request")
		return
	}

	name, failure := checkCategoryName(body.Name, body.IsPublic)
	if failure != "" {
		s.writeError(w, http.StatusBadRequest, failure)
		return
	}

	ctx, cancel := timeout(r, 5*time.Second)
	defer cancel()

	// The ceiling, checked before the write because a task cannot be trimmed
	// away afterwards the way a device's address can. A retry of a create that
	// already landed is not a new task and is let through at the ceiling, which
	// is what keeps this endpoint idempotent — the whole reason the id is
	// minted by the client.
	room, err := s.q.CategoryRoom(ctx, db.CategoryRoomParams{Owner: user.ID, Wanted: pgID(id)})
	if err != nil {
		s.log.Error("count categories", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}
	if !room.Mine && room.Live >= maxCategoriesPerUser {
		s.writeError(w, http.StatusConflict, "too_many_categories")
		return
	}

	now := s.now()
	row, err := s.q.CreateCategory(ctx, db.CreateCategoryParams{
		ID:        pgID(id),
		UserID:    user.ID,
		Name:      name,
		IsPublic:  body.IsPublic,
		CreatedAt: pgTime(now),
	})
	if err != nil {
		s.log.Error("create category", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}
	// A retry returns the row the first attempt made, which may belong to
	// somebody else if a client minted a colliding id. Answering with another
	// user's row would be the leak; answering "not yours" is the truth.
	if row.UserID != user.ID {
		s.writeError(w, http.StatusConflict, "category_not_found")
		return
	}

	writeJSON(w, http.StatusOK, categoryResponse{Category: asCategory(row), ServerNow: now.UnixMilli()})
}

type updateCategoryRequest struct {
	Name     string `json:"name"`
	IsPublic bool   `json:"isPublic"`
}

func (s *Server) updateCategory(w http.ResponseWriter, r *http.Request) {
	user, ok := s.currentUser(r)
	if !ok {
		s.writeError(w, http.StatusUnauthorized, "not_signed_in")
		return
	}

	if !s.spendWrite(w, user) {
		return
	}

	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		s.writeError(w, http.StatusNotFound, "category_not_found")
		return
	}

	var body updateCategoryRequest
	if err := readJSON(r, &body); err != nil {
		s.writeError(w, http.StatusBadRequest, "malformed_request")
		return
	}

	name, failure := checkCategoryName(body.Name, body.IsPublic)
	if failure != "" {
		s.writeError(w, http.StatusBadRequest, failure)
		return
	}

	ctx, cancel := timeout(r, 5*time.Second)
	defer cancel()

	if busy, err := s.categoryIsBusy(ctx, user.ID, id); err != nil {
		s.log.Error("check category is busy", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	} else if busy {
		s.writeError(w, http.StatusConflict, "category_busy")
		return
	}

	now := s.now()
	row, err := s.q.UpdateCategory(ctx, db.UpdateCategoryParams{
		ID:        pgID(id),
		UserID:    user.ID,
		Name:      name,
		IsPublic:  body.IsPublic,
		UpdatedAt: pgTime(now),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		s.writeError(w, http.StatusNotFound, "category_not_found")
		return
	}
	if err != nil {
		s.log.Error("update category", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}

	writeJSON(w, http.StatusOK, categoryResponse{Category: asCategory(row), ServerNow: now.UnixMilli()})
}

func (s *Server) deleteCategory(w http.ResponseWriter, r *http.Request) {
	user, ok := s.currentUser(r)
	if !ok {
		s.writeError(w, http.StatusUnauthorized, "not_signed_in")
		return
	}

	if !s.spendWrite(w, user) {
		return
	}

	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		s.writeError(w, http.StatusNotFound, "category_not_found")
		return
	}

	ctx, cancel := timeout(r, 5*time.Second)
	defer cancel()

	if busy, err := s.categoryIsBusy(ctx, user.ID, id); err != nil {
		s.log.Error("check category is busy", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	} else if busy {
		s.writeError(w, http.StatusConflict, "category_busy")
		return
	}

	// A tombstone rather than a delete: the row keeps its name and every
	// session recorded against it keeps pointing at it, so a tidy-up never
	// costs somebody their history.
	if _, err := s.q.DeleteCategory(ctx, db.DeleteCategoryParams{
		ID: pgID(id), UserID: user.ID, DeletedAt: pgTime(s.now()),
	}); err != nil {
		s.log.Error("delete category", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}

	// Deleting one that was already deleted is not a failure: the caller asked
	// for a state and the state is what it gets.
	w.WriteHeader(http.StatusNoContent)
}

// checkCategoryName trims and vets a name, returning the error code to answer
// with, or "" when the name is fine.
//
// Profanity is checked only when the name is public. A private category's name
// never leaves its owner, and refusing a word only they will ever read would
// be moralising at somebody about their own notes.
func checkCategoryName(raw string, isPublic bool) (name, failure string) {
	name = strings.TrimSpace(raw)
	if length := utf8.RuneCountInString(name); length < categoryNameMin || length > categoryNameMax {
		return "", "category_name_length"
	}
	if isPublic && profanity.Contains(name) {
		return "", "category_name_profane"
	}
	return name, ""
}

// categoryIsBusy reports whether a session is running or ringing on this
// category. A live session cannot be allowed to lose its label or have it
// changed underneath it — what it is recorded against has to be what was
// chosen when it began.
func (s *Server) categoryIsBusy(ctx context.Context, userID pgtype.UUID, id uuid.UUID) (bool, error) {
	return s.q.HasLiveSessionForCategory(ctx, db.HasLiveSessionForCategoryParams{
		UserID:     userID,
		CategoryID: pgID(id),
	})
}

func pgID(id uuid.UUID) pgtype.UUID {
	return pgtype.UUID{Bytes: id, Valid: true}
}

func pgTime(t time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: t, Valid: true}
}
