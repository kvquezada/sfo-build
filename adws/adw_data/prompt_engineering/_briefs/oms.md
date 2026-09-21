<!-- The oms brief: inlined into the system prompt of every agent working on a target whose brief is `oms`. Edit here, not there. -->

## The codebase

An Nx 23 monorepo for an **order management system** for a food business:
customers place orders, the kitchen advances them through stages, and a stats
page reports on the result.

```
apps/api/      NestJS 11 + Mongoose. Modules: orders (+counters), customers,
               products, users, stats, app.
apps/front/    Next.js 16 App Router + React 19 + Tailwind.
libs/shared/   Framework-free domain types, imported as `@oms/shared`.
```

### Domain vocabulary — use these words, they are the code's own

- **Order** — has a `reference` like `ORD-0042` (see `formatOrderReference`),
  a `stage`, a `fulfillmentType`, order lines, and payments.
- **OrderStage** — `placed → preparing → ready → {picked-up | out-for-delivery
  → delivered}`, plus `cancelled`. `ready` is the ONLY branch point, and it
  branches on `fulfillmentType`. `picked-up`, `delivered` and `cancelled` are
  terminal. The graph and its guards live in
  `libs/shared/src/lib/order-stage.ts` — read it before touching anything that
  moves an order forward. Never hard-code a stage list that file already owns.
- **FulfillmentType** — `pickup` | `delivery`.
- **Customer** — identified by `phone`, which is UNIQUE. A duplicate insert
  surfaces as MongoDB error code 11000 and must become a `ConflictException`.
- **Product**, **Channel** (`messenger`/`phone`/`walk-in`/`other`),
  **PaymentMethod** (`gcash`/`bank-transfer`/`cash`/`other`).

### Conventions that are not optional

- **Nest module shape.** A feature is a directory under `apps/api/src/`
  holding `<name>.module.ts`, `<name>.controller.ts`, `<name>.service.ts`,
  `dto/`, and `schemas/`. Follow the existing shape exactly; do not invent a
  new layout.
- **Controllers are thin.** They bind routes, validate via a DTO, and delegate.
  Business logic lives in the service. No Mongoose calls in a controller.
- **DTOs use `class-validator`.** Query DTOs that take numbers need
  `@Transform(({ value }) => Number(value))` before `@IsInt()`, because query
  strings arrive as text. `apps/api/src/orders/dto/find-orders.dto.ts` is the
  reference for this.
- **Invalid ids are 404, not 500.** Every service that takes an `id` calls
  `isValidObjectId(id)` first and throws `NotFoundException`.
- **Tests are colocated** as `*.spec.ts` beside the file they test. Services are
  tested with `Test.createTestingModule` and a hand-rolled mock model injected
  via `getModelToken(X.name)` — never a real database. Read a neighbouring
  `*.spec.ts` before writing one; match its shape.
- **Single quotes, trailing commas, 2-space indent.** Match the file you are in.

### Commands

The suite is run for you by the workflow, not by you. If you want to check your
own work:

```
npx nx run-many -t test      # the whole repo: 3 projects, ~70 tests
npx nx test api              # one project
npx nx lint api
```

Judge any command by its EXIT STATUS, never by scanning output for words.
Nx prints the word `error` inside passing output all the time.
