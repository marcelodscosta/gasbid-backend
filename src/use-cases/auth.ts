import { prisma } from '../lib/prisma'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import {
  ConflictError,
  NotFoundError,
  UnauthorizedError,
} from '../errors/app-error'

interface RegisterInput {
  name: string
  email: string
  password: string
  role: 'BUYER' | 'SUPPLIER'
  company: {
    name: string
    cnpj: string
    phone?: string
    email?: string
  }
}

export async function registerUseCase(data: RegisterInput) {
  const existingUser = await prisma.user.findUnique({ where: { email: data.email } })
  if (existingUser) throw new ConflictError('Email já cadastrado')

  const existingCompany = await prisma.company.findUnique({ where: { cnpj: data.company.cnpj } })
  if (existingCompany) throw new ConflictError('CNPJ já cadastrado')

  const passwordHash = await bcrypt.hash(data.password, 10)

  const company = await prisma.company.create({
    data: {
      name: data.company.name,
      cnpj: data.company.cnpj,
      phone: data.company.phone,
      email: data.company.email,
      role: data.role,
    },
  })

  const user = await prisma.user.create({
    data: {
      name: data.name,
      email: data.email,
      passwordHash,
      role: data.role,
      companyId: company.id,
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      companyId: true,
      createdAt: true,
    },
  })

  return { user, company }
}

export async function loginUseCase(email: string, password: string) {
  const user = await prisma.user.findUnique({
    where: { email },
    include: { company: true },
  })
  if (!user) throw new UnauthorizedError('Credenciais inválidas')

  const valid = await bcrypt.compare(password, user.passwordHash)
  if (!valid) throw new UnauthorizedError('Credenciais inválidas')

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    companyId: user.companyId,
    company: user.company,
  }
}

export async function createRefreshTokenUseCase(userId: string) {
  const token = crypto.randomBytes(64).toString('hex')
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

  await prisma.refreshToken.create({ data: { token, userId, expiresAt } })
  return token
}

export async function refreshAccessTokenUseCase(refreshToken: string) {
  const stored = await prisma.refreshToken.findUnique({
    where: { token: refreshToken },
    include: { user: { include: { company: true } } },
  })

  if (!stored || stored.expiresAt < new Date()) {
    throw new UnauthorizedError('Refresh token inválido ou expirado')
  }

  // Rotate token
  await prisma.refreshToken.delete({ where: { id: stored.id } })
  const newRefreshToken = await createRefreshTokenUseCase(stored.userId)

  return { user: stored.user, newRefreshToken }
}

export async function getMeUseCase(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      companyId: true,
      company: {
        select: {
          id: true,
          name: true,
          cnpj: true,
          role: true,
          addresses: { where: { isMain: true }, take: 1 },
        },
      },
    },
  })
  if (!user) throw new NotFoundError('Usuário')
  return user
}
