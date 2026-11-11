// `npm run db:migrate:local`: the update's own migration step, backup included.
import { migrate } from './update.mjs'

migrate()
