/**
 * Eric's arena settings. Each one set is a row; resetting one keeps its row with a NULL value, so the document still
 * says who changed what last. Values read back are checked against the same schema as a request.
 */
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { ArenaSettings, DEFAULT_SETTINGS } from "./Domain.ts"
import type { SettingsDoc, SettingsPatch } from "./Domain.ts"

const SettingRow = Schema.Struct({
  name: Schema.String,
  value: Schema.NullOr(Schema.Int),
  updatedAt: Schema.String,
  by: Schema.String
})

export type Effective = { readonly [K in keyof typeof DEFAULT_SETTINGS]: number }

export class Settings extends Context.Service<Settings, {
  /** The settings as set, without defaults: what the Settings page shows. */
  readonly get: Effect.Effect<SettingsDoc>
  readonly update: (patch: SettingsPatch, by: string) => Effect.Effect<SettingsDoc>
  /** Every setting, defaults filled in: what a round plays with. */
  readonly effective: Effect.Effect<Effective>
}>()("arena/Settings") {
  static readonly layer = Layer.effect(
    Settings,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const rows = SqlSchema.findAll({
        Request: Schema.Void,
        Result: SettingRow,
        execute: () => sql`SELECT name, value, updated_at, by FROM settings ORDER BY updated_at`
      })
      const decodeSettings = Schema.decodeUnknownEffect(ArenaSettings)

      const get = Effect.gen(function*() {
        const all = yield* rows(undefined)
        const set = Object.fromEntries(all.filter((r) => r.value !== null).map((r) => [r.name, r.value]))
        const last = all.at(-1)
        const doc: SettingsDoc = {
          settings: yield* decodeSettings(set),
          updatedAt: last?.updatedAt ?? null,
          by: last?.by ?? null
        }
        return doc
      }).pipe(Effect.orDie, Effect.withSpan("Settings.get"))

      const update = Effect.fn("Settings.update")(function*(patch: SettingsPatch, by: string) {
        const at = new Date().toISOString()
        yield* sql.withTransaction(Effect.forEach(Object.entries(patch.set), ([name, value]) =>
          sql`INSERT INTO settings ${sql.insert({ name, value: value ?? null, updatedAt: at, by })}
              ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, by = excluded.by`
        )).pipe(Effect.orDie)
        return yield* get
      })

      const effective = Effect.map(get, (doc) => ({ ...DEFAULT_SETTINGS, ...doc.settings }))

      return Settings.of({ get, update, effective })
    })
  )
}
