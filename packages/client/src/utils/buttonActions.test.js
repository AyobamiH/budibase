import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  enrichButtonActions,
  getActionDependentContextKeys,
} from "./buttonActions"

const { API, stores } = vi.hoisted(() => {
  const stores = Object.fromEntries(
    [
      "routeStore",
      "builderStore",
      "confirmationStore",
      "authStore",
      "stateStore",
      "notificationStore",
      "dataSourceStore",
      "uploadStore",
      "rowSelectionStore",
      "sidePanelStore",
      "modalStore",
    ].map(name => [name, { value: {}, actions: {} }])
  )
  stores.notificationStore.actions = {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }
  stores.dataSourceStore.actions.invalidateDataSource = vi.fn()
  stores.confirmationStore.actions.showConfirmation = vi.fn()
  return { API: { saveRow: vi.fn() }, stores }
})

vi.mock("svelte/store", () => ({ get: store => store.value }))
vi.mock("downloadjs", () => ({ default: vi.fn() }))
vi.mock("@budibase/frontend-core", () => ({ downloadStream: vi.fn() }))
vi.mock("@/stores", () => stores)
vi.mock("@/api", () => ({ API }))
vi.mock("@/constants", () => ({
  ActionTypes: { ValidateForm: "ValidateForm" },
  PeekMessages: {},
}))
vi.mock("./enrichDataBinding", () => ({
  enrichDataBindings: action => action,
}))
vi.mock("@budibase/bbui", () => ({
  Helpers: { deepSet: (object, key, value) => (object[key] = value) },
}))
vi.mock("@budibase/shared-core", () => ({ convertDataToExportFormat: vi.fn() }))

const action = (type = "Save Row", parameters = {}) => ({
  "##eventHandlerType": type,
  parameters: { providerId: "form", tableId: "ta_test", ...parameters },
})

const schemaError = {
  status: 400,
  json: { validationErrors: { required: ["can't be blank"] } },
}

const run = (saveAction, context = {}) =>
  enrichButtonActions(
    [
      saveAction,
      {
        "##eventHandlerType": "Show Notification",
        parameters: { type: "info", message: "Next action" },
      },
    ],
    context
  )()

beforeEach(() => {
  vi.resetAllMocks()
  stores.builderStore.value = { inBuilder: false }
  stores.stateStore.value = {}
  API.saveRow.mockResolvedValue({ _id: "ro_saved" })
  stores.dataSourceStore.actions.invalidateDataSource.mockResolvedValue()
})

describe("Save Row form validation after a rejected save", () => {
  it("declares the form validation context dependency", () => {
    expect(getActionDependentContextKeys(action())).toEqual([
      "form",
      "form_ValidateForm",
    ])
    expect(
      getActionDependentContextKeys(
        action("Save Row", { providerId: undefined })
      )
    ).toEqual([])
    expect(getActionDependentContextKeys(action("Duplicate Row"))).toEqual([
      "form",
    ])
  })

  it("reveals errors on the selected form only", async () => {
    API.saveRow.mockRejectedValue(schemaError)
    const validate = vi.fn().mockReturnValue(false)
    const otherValidate = vi.fn()
    await run(action(), {
      form: { required: null, optional: "Filled" },
      form_ValidateForm: validate,
      other_ValidateForm: otherValidate,
    })
    expect(API.saveRow).toHaveBeenCalledOnce()
    expect(validate).toHaveBeenCalledOnce()
    expect(otherValidate).not.toHaveBeenCalled()
    expect(stores.notificationStore.actions.info).not.toHaveBeenCalled()
    expect(stores.notificationStore.actions.success).not.toHaveBeenCalled()
    expect(stores.notificationStore.actions.error).not.toHaveBeenCalled()
    expect(
      stores.dataSourceStore.actions.invalidateDataSource
    ).not.toHaveBeenCalled()
  })

  it("still stops the action chain when client validation passes", async () => {
    API.saveRow.mockRejectedValue(schemaError)
    const validate = vi.fn().mockReturnValue(true)
    await run(action(), { form_ValidateForm: validate })
    expect(validate).toHaveBeenCalledOnce()
    expect(API.saveRow).toHaveBeenCalledOnce()
    expect(stores.notificationStore.actions.info).not.toHaveBeenCalled()
  })

  it("preserves successful saves with field overrides", async () => {
    const validate = vi.fn().mockReturnValue(false)
    await run(action("Save Row", { fields: { required: "Override" } }), {
      form: { required: null, optional: "Filled" },
      form_ValidateForm: validate,
    })
    expect(API.saveRow).toHaveBeenCalledWith({
      required: "Override",
      optional: "Filled",
      tableId: "ta_test",
    })
    expect(validate).not.toHaveBeenCalled()
    expect(stores.notificationStore.actions.success).toHaveBeenCalledOnce()
    expect(stores.notificationStore.actions.info).toHaveBeenCalledOnce()
  })

  it("does not validate overridden values after a failed save", async () => {
    API.saveRow.mockRejectedValue(schemaError)
    const validate = vi.fn()
    await run(action("Save Row", { fields: { required: "Override" } }), {
      form: { required: null },
      form_ValidateForm: validate,
    })
    expect(validate).not.toHaveBeenCalled()
    expect(stores.notificationStore.actions.info).not.toHaveBeenCalled()
  })

  it.each([undefined, null, "not a function"])(
    "supports non-form providers without a callable validator (%s)",
    async validate => {
      API.saveRow.mockRejectedValue(schemaError)
      await run(action(), { form_ValidateForm: validate })
      expect(API.saveRow).toHaveBeenCalledOnce()
      expect(stores.notificationStore.actions.info).not.toHaveBeenCalled()
    }
  )

  it("does not invoke a validator for a save without a provider", async () => {
    API.saveRow.mockRejectedValue(schemaError)
    const validate = vi.fn()
    await run(action("Save Row", { providerId: undefined }), {
      undefined_ValidateForm: validate,
    })
    expect(validate).not.toHaveBeenCalled()
  })

  it.each([
    new Error("Network unavailable"),
    { status: 403, json: { message: "Forbidden" } },
    { json: { validationErrors: {} } },
    { json: { validationErrors: [] } },
    { json: { validationErrors: "invalid" } },
    { json: { validationErrors: null } },
  ])("ignores unrelated or malformed errors (%j)", async error => {
    API.saveRow.mockRejectedValue(error)
    const validate = vi.fn()
    await run(action(), { form_ValidateForm: validate })
    expect(validate).not.toHaveBeenCalled()
    expect(stores.notificationStore.actions.info).not.toHaveBeenCalled()
  })

  it("keeps an explicit Validate Form action able to stop a save", async () => {
    const validate = vi.fn().mockReturnValue(false)
    await enrichButtonActions(
      [
        {
          "##eventHandlerType": "Validate Form",
          parameters: { componentId: "form" },
        },
        action(),
      ],
      { form_ValidateForm: validate }
    )()
    expect(validate).toHaveBeenCalledOnce()
    expect(API.saveRow).not.toHaveBeenCalled()
  })

  it("does not change Duplicate Row validation behaviour", async () => {
    API.saveRow.mockRejectedValue(schemaError)
    const validate = vi.fn()
    await run(action("Duplicate Row"), {
      form: { required: null },
      form_ValidateForm: validate,
    })
    expect(validate).not.toHaveBeenCalled()
    expect(stores.notificationStore.actions.info).not.toHaveBeenCalled()
  })

  it("resolves confirmation when the validator throws", async () => {
    API.saveRow.mockRejectedValue(schemaError)
    const validationError = new Error("Validator failed")
    const validate = vi.fn().mockRejectedValue(validationError)
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const pending = run(action("Save Row", { confirm: true }), {
        form_ValidateForm: validate,
      })
      const confirm =
        stores.confirmationStore.actions.showConfirmation.mock.calls[0][2]
      await confirm()
      await expect(pending).resolves.toBe(false)
      expect(validate).toHaveBeenCalledOnce()
      expect(log).toHaveBeenCalledWith(
        "Failed to display form validation errors",
        validationError
      )
      expect(stores.notificationStore.actions.info).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
  })
})
