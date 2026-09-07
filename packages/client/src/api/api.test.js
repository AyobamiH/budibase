import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "./api"

const { callbacks, appStore, notificationStore, sessionBannerStore, recaptchaStore } =
  vi.hoisted(() => ({
    callbacks: {},
    appStore: { value: {} },
    notificationStore: { actions: { error: vi.fn() } },
    sessionBannerStore: { set: vi.fn() },
    recaptchaStore: { actions: { unverified: vi.fn() } },
  }))

vi.mock("@budibase/frontend-core", () => ({
  createAPIClient: config => {
    callbacks.onError = config.onError
    return {}
  },
  sessionBannerStore,
  redirectToLoginWithReturnUrl: vi.fn(),
}))
vi.mock("svelte/store", () => ({ get: store => store.value }))
vi.mock("../stores/auth", () => ({ authStore: { value: {} } }))
vi.mock("../stores", () => ({
  appStore,
  notificationStore,
  recaptchaStore,
  devToolsEnabled: { value: false },
  devToolsStore: { value: {} },
}))

const validationErrors = { required_display_column: ["can't be blank"] }
const makeError = (overrides = {}) => ({
  status: 500,
  method: "POST",
  url: "/api/ta_test/rows",
  message: "",
  handled: true,
  suppressErrors: false,
  json: { status: 500, validationErrors },
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  appStore.value = {}
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("API error notifications", () => {
  it.each(["", undefined])(
    "shows structured validation errors without a message (%s)",
    message => {
      callbacks.onError(makeError({ message }))
      expect(notificationStore.actions.error).toHaveBeenCalledExactlyOnceWith(
        "required_display_column can't be blank"
      )
      expect(console.warn).toHaveBeenCalledOnce()
    }
  )

  it("shows every field error without requiring a general message", () => {
    callbacks.onError(
      makeError({
        json: {
          validationErrors: {
            required: ["can't be blank"],
            email: ["is invalid"],
          },
        },
      })
    )
    expect(notificationStore.actions.error.mock.calls).toEqual([
      ["required can't be blank"],
      ["email is invalid"],
    ])
  })

  it("does not duplicate validation errors with a general message", () => {
    callbacks.onError(makeError({ message: "Internal Server Error" }))
    expect(notificationStore.actions.error).toHaveBeenCalledExactlyOnceWith(
      "required_display_column can't be blank"
    )
  })

  it("preserves notifications for ordinary message-only errors", () => {
    callbacks.onError(makeError({ message: "Save failed", json: null }))
    expect(notificationStore.actions.error).toHaveBeenCalledExactlyOnceWith(
      "Save failed"
    )
  })

  it("honours per-request notification suppression", () => {
    callbacks.onError(makeError({ suppressErrors: true }))
    expect(notificationStore.actions.error).not.toHaveBeenCalled()
    expect(sessionBannerStore.set).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledOnce()
  })

  it("honours application-level notification suppression", () => {
    appStore.value = {
      application: { features: { suppressErrorNotifications: true } },
    }
    callbacks.onError(makeError())
    expect(notificationStore.actions.error).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledOnce()
  })

  it.each(["/api/bbtel", "/api/global/self", "/api/tables/ta_users"])(
    "preserves ignored error URLs (%s)",
    url => {
      callbacks.onError(makeError({ url }))
      expect(notificationStore.actions.error).not.toHaveBeenCalled()
      expect(sessionBannerStore.set).not.toHaveBeenCalled()
    }
  )

  it.each([401, 403])(
    "prioritises the authentication banner over field errors (%s)",
    status => {
      callbacks.onError(makeError({ status, message: "Unauthenticated" }))
      expect(sessionBannerStore.set).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "session-not-authenticated" })
      )
      expect(notificationStore.actions.error).not.toHaveBeenCalled()
    }
  )

  it("preserves recaptcha expiry handling", () => {
    callbacks.onError(makeError({ status: 498 }))
    expect(recaptchaStore.actions.unverified).toHaveBeenCalledOnce()
    expect(notificationStore.actions.error).not.toHaveBeenCalled()
    expect(sessionBannerStore.set).not.toHaveBeenCalled()
  })

  it("only logs errors that the API client has not handled", () => {
    const error = makeError({ handled: false })
    callbacks.onError(error)
    expect(console.error).toHaveBeenCalledWith(
      "Unhandled error from API client",
      error
    )
    expect(notificationStore.actions.error).not.toHaveBeenCalled()
  })

  it.each([null, {}, { validationErrors: {} }])(
    "does not create a blank notification when there are no errors (%j)",
    json => {
      callbacks.onError(makeError({ json }))
      expect(notificationStore.actions.error).not.toHaveBeenCalled()
    }
  )
})
