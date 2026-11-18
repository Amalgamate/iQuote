#!/usr/bin/env node
/**
 * Promote a user to SUPERADMIN.
 *
 * Run from the api/ directory:
 *   cd api && node ../scripts/promote-superadmin.mjs user@example.com
 *
 * Or from project root with NODE_PATH:
 *   NODE_PATH=./api/node_modules node scripts/promote-superadmin.mjs user@example.com
 *
 * Requires DATABASE_URL to be set (reads from api/.env automatically).
 */
import { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'
import { resolve } from 'path'

// Load env from api/.env (works whether run from api/ or project root)
config({ path: resolve(process.cwd(), '.env') })
config({ path: resolve(process.cwd(), 'api/.env') })

const prisma = new PrismaClient()

const email = process.argv[2] ?? process.env.SUPERADMIN_EMAIL

if (!email) {
  console.error('Usage: node scripts/promote-superadmin.mjs <email>')
  console.error('   or: SUPERADMIN_EMAIL=<email> node scripts/promote-superadmin.mjs')
  process.exit(1)
}

const normalized = email.trim().toLowerCase()

async function main() {
  const user = await prisma.user.findUnique({ where: { email: normalized } })
  if (!user) {
    console.error(`No user found with email: ${normalized}`)
    console.error('The user must register first, then run this script.')
    process.exit(1)
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { role: 'SUPERADMIN' },
    select: { id: true, name: true, email: true, role: true },
  })

  console.log('Superadmin promoted successfully:')
  console.log(`  Name:  ${updated.name}`)
  console.log(`  Email: ${updated.email}`)
  console.log(`  Role:  ${updated.role}`)
  console.log(`  ID:    ${updated.id}`)
  console.log('')
  console.log('This user will now see the Superadmin Dashboard on login.')
}

main()
  .catch((err) => {
    console.error('Error:', err.message)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
