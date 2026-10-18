import { describe, it, expect } from 'vitest'
import { Prisma } from '@prisma/client'
import {
  ACTIVE_ORDER_STATUSES,
  ORDER_TRANSITIONS,
  REQUEST_TRANSITIONS,
  BUYER_REQUEST_MANUAL,
  canTransition,
} from './state-machine'
import { proposalTotal, round2, serializeDecimals, toNum } from './money'

describe('state-machine', () => {
  it('pedido segue a ordem estrita, sem pular etapas', () => {
    expect(canTransition(ORDER_TRANSITIONS, 'PENDING_CONFIRMATION', 'CONFIRMED')).toBe(true)
    expect(canTransition(ORDER_TRANSITIONS, 'CONFIRMED', 'IN_DELIVERY')).toBe(true)
    expect(canTransition(ORDER_TRANSITIONS, 'IN_DELIVERY', 'DELIVERED')).toBe(true)
    expect(canTransition(ORDER_TRANSITIONS, 'PENDING_CONFIRMATION', 'DELIVERED')).toBe(false)
    expect(canTransition(ORDER_TRANSITIONS, 'CONFIRMED', 'DELIVERED')).toBe(false)
  })

  it('DELIVERED e CANCELLED são estados finais', () => {
    for (const final of ['DELIVERED', 'CANCELLED'] as const) {
      expect(ORDER_TRANSITIONS[final]).toEqual([])
    }
    for (const final of ['CANCELLED', 'EXPIRED'] as const) {
      expect(REQUEST_TRANSITIONS[final]).toEqual([])
    }
  })

  it('pedido ativo inclui PENDING_CONFIRMATION', () => {
    expect(ACTIVE_ORDER_STATUSES).toEqual(['PENDING_CONFIRMATION', 'CONFIRMED', 'IN_DELIVERY'])
  })

  it('cotação: não reabre cancelada/expirada nem vai direto de OPEN para algo inválido', () => {
    expect(canTransition(REQUEST_TRANSITIONS, 'CANCELLED', 'OPEN')).toBe(false)
    expect(canTransition(REQUEST_TRANSITIONS, 'EXPIRED', 'OPEN')).toBe(false)
    expect(canTransition(REQUEST_TRANSITIONS, 'OPEN', 'UNDER_REVIEW')).toBe(true)
    expect(canTransition(REQUEST_TRANSITIONS, 'AWARDED', 'UNDER_REVIEW')).toBe(true) // via sistema/cron
  })

  it('o comprador só define manualmente UNDER_REVIEW e CANCELLED', () => {
    expect(BUYER_REQUEST_MANUAL).toEqual(['UNDER_REVIEW', 'CANCELLED'])
  })
})

describe('money', () => {
  it('soma sem erro de ponto flutuante', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3)
    expect(proposalTotal([{ unitPrice: new Prisma.Decimal('0.10'), quantity: 3 }], new Prisma.Decimal('0.20'))).toBe(0.5)
  })

  it('total = Σ(preço × quantidade da solicitação) + frete', () => {
    const items = [
      { unitPrice: 100, buyerRequestItem: { quantity: 5 } },
      { unitPrice: 50.5, buyerRequestItem: { quantity: 2 } },
    ]
    expect(proposalTotal(items, 20)).toBe(621)
  })

  it('toNum aceita Decimal, string, null e undefined', () => {
    expect(toNum(new Prisma.Decimal('12.34'))).toBe(12.34)
    expect(toNum('7.5')).toBe(7.5)
    expect(toNum(null)).toBe(0)
    expect(toNum(undefined)).toBe(0)
  })

  it('serializeDecimals converte Decimal em number recursivamente, preservando datas', () => {
    const date = new Date()
    const out: any = serializeDecimals({
      totalPrice: new Prisma.Decimal('19.90'),
      items: [{ unitPrice: new Prisma.Decimal('3.5') }],
      createdAt: date,
      nested: { ok: true, none: null },
    })
    expect(out.totalPrice).toBe(19.9)
    expect(out.items[0].unitPrice).toBe(3.5)
    expect(out.createdAt).toBe(date)
    expect(out.nested).toEqual({ ok: true, none: null })
  })
})
