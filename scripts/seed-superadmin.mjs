/**
 * Create a superadmin user directly in the database.
 *
 * Usage (inside the API container):
 *   node scripts/seed-superadmin.mjs "Name" "email@example.com" "password"
 *
 * Or with env vars:
 *   SEED_NAME="Name" SEED_EMAIL=email@example.com SEED_PASSWORD=pass node scripts/seed-superadmin.mjs
 */
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

const name = process.argv[2] ?? process.env.SEED_NAME
const email = (process.argv[3] ?? process.env.SEED_EMAIL ?? '').trim().toLowerCase()
const password = process.argv[4] ?? process.env.SEED_PASSWORD

if (!name || !email || !password) {
  console.error('Usage: node scripts/seed-superadmin.mjs "Name" "email@example.com" "password"')
  process.exit(1)
}

async function main() {
  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) {
    const updated = await prisma.user.update({
      where: { id: existing.id },
      data: { role: 'SUPERADMIN' },
      select: { id: true, name: true, email: true, role: true },
    })
    console.log('User already existed — promoted to SUPERADMIN:')
    console.log(`  Name:  ${updated.name}`)
    console.log(`  Email: ${updated.email}`)
    console.log(`  Role:  ${updated.role}`)
    return
  }

  const passwordHash = await bcrypt.hash(password, 10)
  const user = await prisma.user.create({
    data: {
      name,
      email,
      passwordHash,
      role: 'SUPERADMIN',
      emailVerifiedAt: new Date(),
    },
    select: { id: true, name: true, email: true, role: true },
  })

  console.log('Superadmin created successfully:')
  console.log(`  Name:  ${user.name}`)
  console.log(`  Email: ${user.email}`)
  console.log(`  Role:  ${user.role}`)
  console.log(`  ID:    ${user.id}`)
  console.log('')
  console.log('This user will see the Superadmin Dashboard on login.')
}

main()
  .catch((err) => {
    console.error('Error:', err.message)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
