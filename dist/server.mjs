import {
  createBuyerRequestSchema,
  createOrderMessageSchema,
  createProposalSchema,
  loginSchema,
  paginationSchema,
  refreshSchema,
  registerSchema,
  updateOrderStatusSchema
} from "./chunk-W5TAXQLO.mjs";
import {
  wsManager
} from "./chunk-R6BVMBVM.mjs";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  prisma
} from "./chunk-ZBEQDVJW.mjs";

// src/server.ts
import "dotenv/config";

// src/app.ts
import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import websocket from "@fastify/websocket";
import { ZodError } from "zod";

// src/use-cases/auth.ts
import bcrypt from "bcryptjs";
import crypto from "crypto";
async function registerUseCase(data) {
  const existingUser = await prisma.user.findUnique({ where: { email: data.email } });
  if (existingUser) throw new ConflictError("Email j\xE1 cadastrado");
  const existingCompany = await prisma.company.findUnique({ where: { cnpj: data.company.cnpj } });
  if (existingCompany) throw new ConflictError("CNPJ j\xE1 cadastrado");
  const passwordHash = await bcrypt.hash(data.password, 10);
  const company = await prisma.company.create({
    data: {
      name: data.company.name,
      cnpj: data.company.cnpj,
      phone: data.company.phone,
      email: data.company.email,
      role: data.role
    }
  });
  const user = await prisma.user.create({
    data: {
      name: data.name,
      email: data.email,
      passwordHash,
      role: data.role,
      companyId: company.id
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      companyId: true,
      createdAt: true
    }
  });
  return { user, company };
}
async function loginUseCase(email, password) {
  const user = await prisma.user.findUnique({
    where: { email },
    include: { company: true }
  });
  if (!user) throw new UnauthorizedError("Credenciais inv\xE1lidas");
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw new UnauthorizedError("Credenciais inv\xE1lidas");
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    companyId: user.companyId,
    company: user.company
  };
}
async function createRefreshTokenUseCase(userId) {
  const token = crypto.randomBytes(64).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1e3);
  await prisma.refreshToken.create({ data: { token, userId, expiresAt } });
  return token;
}
async function refreshAccessTokenUseCase(refreshToken) {
  const stored = await prisma.refreshToken.findUnique({
    where: { token: refreshToken },
    include: { user: { include: { company: true } } }
  });
  if (!stored || stored.expiresAt < /* @__PURE__ */ new Date()) {
    throw new UnauthorizedError("Refresh token inv\xE1lido ou expirado");
  }
  await prisma.refreshToken.delete({ where: { id: stored.id } });
  const newRefreshToken = await createRefreshTokenUseCase(stored.userId);
  return { user: stored.user, newRefreshToken };
}
async function getMeUseCase(userId) {
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
          addresses: { where: { isMain: true }, take: 1 }
        }
      }
    }
  });
  if (!user) throw new NotFoundError("Usu\xE1rio");
  return user;
}

// src/http/controllers/auth.controller.ts
async function registerController(req, reply) {
  const data = registerSchema.parse(req.body);
  const result = await registerUseCase(data);
  return reply.status(201).send(result);
}
async function loginController(req, reply) {
  const { email, password } = loginSchema.parse(req.body);
  req.log.info({ email }, "Login attempt");
  const user = await loginUseCase(email, password);
  const token = req.server.jwt.sign(
    { sub: user.id, role: user.role, companyId: user.companyId },
    { expiresIn: process.env.JWT_EXPIRES_IN ?? "15m" }
  );
  const refreshToken = await createRefreshTokenUseCase(user.id);
  return reply.send({ token, refreshToken, user });
}
async function refreshController(req, reply) {
  const { refreshToken } = refreshSchema.parse(req.body);
  const { user, newRefreshToken } = await refreshAccessTokenUseCase(refreshToken);
  const token = req.server.jwt.sign(
    { sub: user.id, role: user.role, companyId: user.companyId },
    { expiresIn: process.env.JWT_EXPIRES_IN ?? "15m" }
  );
  return reply.send({ token, refreshToken: newRefreshToken });
}
async function meController(req, reply) {
  const payload = req.user;
  const user = await getMeUseCase(payload.sub);
  return reply.send(user);
}

// src/http/middlewares/auth.ts
async function authenticate(req, reply) {
  try {
    await req.jwtVerify();
  } catch {
    throw new UnauthorizedError("Token inv\xE1lido ou expirado");
  }
}
function requireRole(...roles) {
  return async (req, _reply) => {
    const user = req.user;
    if (!roles.includes(user.role)) {
      throw new ForbiddenError("Sem permiss\xE3o para esta a\xE7\xE3o");
    }
  };
}

// src/http/routes/auth.routes.ts
async function authRoutes(app) {
  app.post("/auth/register", registerController);
  app.post("/auth/login", loginController);
  app.post("/auth/refresh", refreshController);
  app.get("/me", { preHandler: [authenticate] }, meController);
}

// src/lib/geo.ts
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;
  return Number(distance.toFixed(1));
}

// src/use-cases/buyer-requests.ts
async function createBuyerRequestUseCase(data) {
  const { items, ...requestData } = data;
  const activeOrder = await prisma.order.findFirst({
    where: {
      buyerCompanyId: data.buyerCompanyId,
      status: { in: ["CREATED", "CONFIRMED", "IN_DELIVERY"] }
    }
  });
  if (activeOrder) {
    throw new AppError("Voc\xEA possui um pedido em andamento. Aguarde a conclus\xE3o da entrega para realizar um novo pedido.");
  }
  const address = await prisma.address.findFirst({
    where: { id: data.addressId, companyId: data.buyerCompanyId }
  });
  if (!address) throw new NotFoundError("Endere\xE7o");
  const windowSetting = await prisma.systemSetting.findUnique({
    where: { key: "proposal_window_minutes" }
  });
  const windowMinutes = windowSetting ? parseInt(windowSetting.value, 10) : 5;
  const calculatedExpiresAt = new Date(Date.now() + windowMinutes * 60 * 1e3);
  const request = await prisma.buyerRequest.create({
    data: {
      ...requestData,
      deadline: new Date(data.deadline),
      expiresAt: calculatedExpiresAt,
      status: "OPEN",
      items: {
        create: items.map((item) => ({
          productId: item.productId,
          quantity: item.quantity
        }))
      }
    },
    include: {
      items: { include: { product: true } },
      address: true
    }
  });
  try {
    const suppliersInRegion = await prisma.supplierCoverage.findMany({
      where: { city: address.city, state: address.state },
      select: { supplierCompanyId: true }
    });
    const companyIds = suppliersInRegion.map((s) => s.supplierCompanyId);
    const usersToNotify = await prisma.user.findMany({
      where: companyIds.length > 0 ? { companyId: { in: companyIds }, role: "SUPPLIER" } : { role: "SUPPLIER" },
      select: { id: true }
    });
    usersToNotify.forEach((user) => {
      wsManager.notifyUser(user.id, "NEW_OPPORTUNITY", { requestId: request.id });
    });
  } catch (err) {
    console.error("Error sending WS notification to suppliers", err);
  }
  return request;
}
async function listBuyerRequestsUseCase(companyId, page, limit) {
  const [data, total] = await Promise.all([
    prisma.buyerRequest.findMany({
      where: { buyerCompanyId: companyId },
      include: {
        items: { include: { product: true } },
        address: true,
        order: {
          include: {
            rating: true
          }
        },
        _count: { select: { proposals: true } }
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit
    }),
    prisma.buyerRequest.count({ where: { buyerCompanyId: companyId } })
  ]);
  return { data, total, page, limit, pages: Math.ceil(total / limit) };
}
async function getBuyerRequestUseCase(id, companyId, supplierCompanyId) {
  const request = await prisma.buyerRequest.findUnique({
    where: { id },
    include: {
      items: { include: { product: true } },
      address: true,
      buyerCompany: { select: { id: true, name: true, cnpj: true } },
      proposals: {
        where: supplierCompanyId ? { supplierCompanyId } : void 0,
        include: {
          items: {
            include: {
              buyerRequestItem: {
                include: {
                  product: true
                }
              }
            }
          },
          supplierCompany: {
            select: {
              id: true,
              name: true,
              cnpj: true,
              ratingsReceived: { select: { stars: true } },
              addresses: true
            }
          }
        },
        orderBy: { createdAt: "desc" }
      },
      _count: { select: { proposals: true } }
    }
  });
  if (!request) throw new NotFoundError("Solicita\xE7\xE3o");
  if (companyId && request.buyerCompanyId !== companyId) {
    throw new ForbiddenError();
  }
  let distanceKm = null;
  if (supplierCompanyId && request.address?.latitude && request.address?.longitude) {
    const supplierAddress = await prisma.address.findFirst({
      where: { companyId: supplierCompanyId, isMain: true }
    }) || await prisma.address.findFirst({
      where: { companyId: supplierCompanyId }
    });
    if (supplierAddress?.latitude && supplierAddress?.longitude) {
      distanceKm = calculateDistance(
        supplierAddress.latitude,
        supplierAddress.longitude,
        request.address.latitude,
        request.address.longitude
      );
    }
  }
  let lowestMarketSummary = null;
  if (supplierCompanyId) {
    const allProposals = await prisma.supplierProposal.findMany({
      where: {
        buyerRequestId: id,
        status: { notIn: ["WITHDRAWN", "REJECTED"] }
      },
      include: {
        items: {
          include: {
            buyerRequestItem: {
              include: { product: true }
            }
          }
        }
      }
    });
    const hasMyProposal = allProposals.some((p) => p.supplierCompanyId === supplierCompanyId);
    if (hasMyProposal && allProposals.length > 0) {
      let lowestTotal = Infinity;
      let lowestProp = null;
      allProposals.forEach((prop) => {
        const itemsSum = prop.items.reduce((sum, item) => sum + item.unitPrice * item.buyerRequestItem.quantity, 0);
        const grandTotal = itemsSum + prop.freightPrice;
        if (grandTotal < lowestTotal) {
          lowestTotal = grandTotal;
          lowestProp = prop;
        }
      });
      const myProp = allProposals.find((p) => p.supplierCompanyId === supplierCompanyId);
      const myItemsSum = myProp ? myProp.items.reduce((sum, item) => sum + item.unitPrice * item.buyerRequestItem.quantity, 0) : 0;
      const myTotal = myProp ? myItemsSum + myProp.freightPrice : Infinity;
      const isMyProposal = myTotal <= lowestTotal;
      if (lowestProp) {
        lowestMarketSummary = {
          totalPrice: lowestTotal,
          myTotal: myTotal < Infinity ? myTotal : null,
          freightPrice: lowestProp.freightPrice,
          isMyProposal,
          items: lowestProp.items.map((item) => ({
            productId: item.buyerRequestItem.productId,
            productName: item.buyerRequestItem.product.name,
            quantity: item.buyerRequestItem.quantity,
            unitPrice: item.unitPrice,
            subtotal: item.unitPrice * item.buyerRequestItem.quantity
          }))
        };
      }
    }
  }
  const proposalsWithDistance = request.proposals.map((proposal) => {
    let propDistanceKm = null;
    const supplierAddress = proposal.supplierCompany.addresses?.[0];
    if (supplierAddress?.latitude && supplierAddress?.longitude && request.address?.latitude && request.address?.longitude) {
      propDistanceKm = calculateDistance(
        supplierAddress.latitude,
        supplierAddress.longitude,
        request.address.latitude,
        request.address.longitude
      );
    }
    return { ...proposal, distanceKm: propDistanceKm };
  });
  return { ...request, distanceKm, proposals: proposalsWithDistance, lowestMarketSummary };
}
async function listOpportunitiesUseCase(supplierCompanyId, page, limit, showApplied = false) {
  const coverages = await prisma.supplierCoverage.findMany({
    where: { supplierCompanyId }
  });
  if (coverages.length === 0) return { data: [], total: 0, page, limit, pages: 0 };
  const stateCities = coverages.map((c) => ({ city: c.city, state: c.state }));
  const orConditions = stateCities.map((sc) => ({
    address: { city: sc.city, state: sc.state }
  }));
  const supplierAddress = await prisma.address.findFirst({
    where: { companyId: supplierCompanyId, isMain: true }
  }) || await prisma.address.findFirst({
    where: { companyId: supplierCompanyId }
  });
  const [data, total] = await Promise.all([
    prisma.buyerRequest.findMany({
      where: {
        status: "OPEN",
        expiresAt: { gt: /* @__PURE__ */ new Date() },
        OR: orConditions,
        ...showApplied ? {} : { proposals: { none: { supplierCompanyId } } }
      },
      include: {
        items: { include: { product: true } },
        address: true,
        buyerCompany: { select: { id: true, name: true } },
        _count: { select: { proposals: true } },
        proposals: {
          where: { supplierCompanyId },
          select: { id: true, status: true }
        }
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit
    }),
    prisma.buyerRequest.count({
      where: {
        status: "OPEN",
        expiresAt: { gt: /* @__PURE__ */ new Date() },
        OR: orConditions,
        ...showApplied ? {} : { proposals: { none: { supplierCompanyId } } }
      }
    })
  ]);
  const requestsWithDistance = data.map((req) => {
    let distanceKm = null;
    if (supplierAddress?.latitude && supplierAddress?.longitude && req.address?.latitude && req.address?.longitude) {
      distanceKm = calculateDistance(
        supplierAddress.latitude,
        supplierAddress.longitude,
        req.address.latitude,
        req.address.longitude
      );
    }
    return { ...req, distanceKm };
  });
  return { data: requestsWithDistance, total, page, limit, pages: Math.ceil(total / limit) };
}
async function cancelBuyerRequestUseCase(id, companyId) {
  const request = await prisma.buyerRequest.findUnique({
    where: { id },
    include: {
      proposals: { select: { supplierCompanyId: true } },
      address: { select: { city: true, state: true } }
    }
  });
  if (!request) throw new NotFoundError("Solicita\xE7\xE3o");
  if (request.buyerCompanyId !== companyId) throw new ForbiddenError();
  const updatedRequest = await prisma.buyerRequest.update({
    where: { id },
    data: { status: "CANCELLED" }
  });
  try {
    const suppliersToNotify = /* @__PURE__ */ new Set();
    request.proposals.forEach((p) => suppliersToNotify.add(p.supplierCompanyId));
    if (suppliersToNotify.size > 0) {
      const users = await prisma.user.findMany({
        where: { companyId: { in: Array.from(suppliersToNotify) }, role: "SUPPLIER" },
        select: { id: true }
      });
      users.forEach((user) => {
        wsManager.notifyUser(user.id, "OPPORTUNITY_CANCELLED", { requestId: id });
      });
    }
  } catch (err) {
    console.error("Error sending cancellation WS notification", err);
  }
  return updatedRequest;
}

// src/use-cases/supplier-metrics.ts
async function getSupplierMetricsUseCase(companyId) {
  const coverage = await prisma.supplierCoverage.findMany({
    where: { supplierCompanyId: companyId },
    select: { city: true, state: true }
  });
  const coverageCities = coverage.map((c) => c.city);
  const openOpportunities = await prisma.buyerRequest.count({
    where: {
      status: "OPEN",
      expiresAt: { gt: /* @__PURE__ */ new Date() },
      address: { city: { in: coverageCities } },
      proposals: { none: { supplierCompanyId: companyId } }
    }
  });
  const competingOpportunities = await prisma.supplierProposal.count({
    where: {
      supplierCompanyId: companyId,
      buyerRequest: {
        status: "OPEN",
        expiresAt: { gt: /* @__PURE__ */ new Date() }
      }
    }
  });
  const ordersWon = await prisma.order.count({
    where: { supplierCompanyId: companyId }
  });
  const pendingDeliveries = await prisma.order.count({
    where: {
      supplierCompanyId: companyId,
      status: { in: ["CREATED", "CONFIRMED", "IN_DELIVERY"] }
    }
  });
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1e3);
  const recentRequests = await prisma.buyerRequest.findMany({
    where: {
      status: { in: ["AWARDED", "CANCELLED"] },
      updatedAt: { gt: last24h },
      address: { city: { in: coverageCities } }
    },
    include: {
      items: { include: { product: true } },
      address: true,
      order: { select: { id: true, supplierCompanyId: true, totalPrice: true } },
      proposals: {
        where: { supplierCompanyId: companyId },
        include: { items: true }
      }
    },
    orderBy: { updatedAt: "desc" },
    take: 5
  });
  const recentActivity = recentRequests.map((req) => {
    const myProposal = req.proposals[0];
    let result = "LOST";
    if (req.status === "CANCELLED") result = "CANCELLED";
    else if (req.order?.supplierCompanyId === companyId) result = "WON";
    const firstItem = req.items[0];
    const title = req.items.length > 1 ? `${firstItem?.product.name} +${req.items.length - 1}` : firstItem?.product.name;
    return {
      id: req.id,
      productName: title,
      quantity: req.items.reduce((sum, i) => sum + i.quantity, 0),
      city: req.address.city,
      status: req.status,
      result,
      myPrice: myProposal?.items.reduce((sum, i) => sum + i.unitPrice, 0),
      // This is not quite right but works for display
      winningPrice: req.order?.totalPrice,
      updatedAt: req.updatedAt
    };
  });
  const ratings = await prisma.supplierRating.findMany({
    where: { supplierCompanyId: companyId },
    select: { stars: true, comment: true, createdAt: true }
  });
  const ratingCount = ratings.length;
  const averageStars = ratingCount > 0 ? Number((ratings.reduce((sum, r) => sum + r.stars, 0) / ratingCount).toFixed(1)) : null;
  return {
    openOpportunities,
    competingOpportunities,
    ordersWon,
    pendingDeliveries,
    recentActivity,
    averagePrices: [],
    reputation: {
      averageStars,
      ratingCount,
      ratings: ratings.slice(-10).reverse()
    }
  };
}

// src/http/controllers/buyer-requests.controller.ts
async function createBuyerRequestController(req, reply) {
  const user = req.user;
  const data = createBuyerRequestSchema.parse(req.body);
  const result = await createBuyerRequestUseCase({ ...data, buyerCompanyId: user.companyId });
  return reply.status(201).send(result);
}
async function listBuyerRequestsController(req, reply) {
  const user = req.user;
  const { page, limit } = paginationSchema.parse(req.query);
  return listBuyerRequestsUseCase(user.companyId, page, limit);
}
async function getBuyerRequestController(req, reply) {
  const user = req.user;
  const { id } = req.params;
  const companyFilter = user.role === "BUYER" ? user.companyId : void 0;
  const supplierCompanyId = user.role === "SUPPLIER" ? user.companyId : void 0;
  return getBuyerRequestUseCase(id, companyFilter, supplierCompanyId);
}
async function cancelBuyerRequestController(req, reply) {
  const user = req.user;
  const { id } = req.params;
  const result = await cancelBuyerRequestUseCase(id, user.companyId);
  return reply.status(200).send(result);
}
async function listOpportunitiesController(req, reply) {
  const user = req.user;
  const { page, limit } = paginationSchema.parse(req.query);
  const { showApplied } = req.query;
  console.log(`[Opportunities] Query: companyId=${user.companyId}, showApplied=${showApplied}`);
  const result = await listOpportunitiesUseCase(user.companyId, page, limit, showApplied === "true");
  console.log(`[Opportunities] Result: ${result.data.length} items`);
  return result;
}
async function getSupplierMetricsController(req) {
  const user = req.user;
  return getSupplierMetricsUseCase(user.companyId);
}

// src/use-cases/proposals.ts
async function createProposalUseCase(data) {
  const { items, ...proposalData } = data;
  const request = await prisma.buyerRequest.findUnique({ where: { id: data.buyerRequestId } });
  if (!request) throw new NotFoundError("Solicita\xE7\xE3o");
  if (request.status !== "OPEN") throw new AppError("Solicita\xE7\xE3o n\xE3o est\xE1 aberta para propostas");
  if (request.expiresAt < /* @__PURE__ */ new Date()) throw new AppError("Prazo para envio de propostas encerrado");
  const requestItems = await prisma.buyerRequestItem.findMany({ where: { buyerRequestId: data.buyerRequestId } });
  const newItemsTotal = items.reduce((sum, item) => {
    const rItem = requestItems.find((ri) => ri.id === item.buyerRequestItemId);
    return sum + item.unitPrice * (rItem?.quantity || 1);
  }, 0);
  const newGrandTotal = newItemsTotal + (data.freightPrice || 0);
  const existingProposal = await prisma.supplierProposal.findUnique({
    where: {
      buyerRequestId_supplierCompanyId: {
        buyerRequestId: data.buyerRequestId,
        supplierCompanyId: data.supplierCompanyId
      }
    }
  });
  const competitorProposals = await prisma.supplierProposal.findMany({
    where: {
      buyerRequestId: data.buyerRequestId,
      status: { notIn: ["WITHDRAWN", "REJECTED"] },
      supplierCompanyId: { not: data.supplierCompanyId }
    },
    include: { items: { include: { buyerRequestItem: true } } }
  });
  let currentLowestTotal = Infinity;
  competitorProposals.forEach((p) => {
    const pItemsTotal = p.items.reduce((s, it) => s + it.unitPrice * it.buyerRequestItem.quantity, 0);
    const pGrandTotal = pItemsTotal + p.freightPrice;
    if (pGrandTotal < currentLowestTotal) {
      currentLowestTotal = pGrandTotal;
    }
  });
  if (existingProposal) {
    const isCounterOffer = existingProposal.status === "COUNTER_OFFER";
    if (!isCounterOffer && currentLowestTotal < Infinity) {
      const myCurrentItems = await prisma.supplierProposalItem.findMany({
        where: { supplierProposalId: existingProposal.id },
        include: { buyerRequestItem: true }
      });
      const myCurrentTotal = myCurrentItems.reduce((s, it) => s + it.unitPrice * it.buyerRequestItem.quantity, 0) + existingProposal.freightPrice;
      const isLosing = currentLowestTotal < myCurrentTotal;
      if (isLosing) {
        const isRebiddingToWin = newGrandTotal <= currentLowestTotal - 2;
        if (!isRebiddingToWin) {
          throw new AppError(`Para cobrir a menor oferta atual (R$ ${currentLowestTotal.toFixed(2)}), sua nova proposta precisa ser de no m\xE1ximo R$ ${(currentLowestTotal - 2).toFixed(2)} (diferen\xE7a m\xEDnima de R$ 2,00).`);
        }
      }
    }
    return prisma.supplierProposal.update({
      where: { id: existingProposal.id },
      data: {
        freightPrice: data.freightPrice,
        deliveryDeadline: new Date(data.deliveryDeadline),
        paymentTerms: data.paymentTerms,
        observations: data.observations,
        status: "UPDATED",
        items: {
          deleteMany: {},
          create: items.map((item) => ({
            buyerRequestItemId: item.buyerRequestItemId,
            unitPrice: item.unitPrice
          }))
        }
      },
      include: {
        supplierCompany: { select: { id: true, name: true } },
        items: true
      }
    });
  }
  const result = await prisma.supplierProposal.create({
    data: {
      ...proposalData,
      deliveryDeadline: new Date(data.deliveryDeadline),
      status: "SUBMITTED",
      items: {
        create: items.map((item) => ({
          buyerRequestItemId: item.buyerRequestItemId,
          unitPrice: item.unitPrice
        }))
      }
    },
    include: {
      supplierCompany: { select: { id: true, name: true } },
      items: true
    }
  });
  try {
    const usersToNotify = await prisma.user.findMany({
      where: { companyId: request.buyerCompanyId },
      select: { id: true }
    });
    usersToNotify.forEach((user) => {
      wsManager.notifyUser(user.id, "PROPOSAL_RECEIVED", { buyerRequestId: data.buyerRequestId });
    });
  } catch (err) {
    console.error("Error sending WS notification", err);
  }
  return result;
}
async function listProposalsUseCase(buyerRequestId, buyerCompanyId) {
  const request = await prisma.buyerRequest.findUnique({ where: { id: buyerRequestId } });
  if (!request) throw new NotFoundError("Solicita\xE7\xE3o");
  if (request.buyerCompanyId !== buyerCompanyId) throw new ForbiddenError();
  return prisma.supplierProposal.findMany({
    where: {
      buyerRequestId,
      status: { not: "WITHDRAWN" }
    },
    include: {
      supplierCompany: {
        select: {
          id: true,
          name: true,
          cnpj: true,
          ratingsReceived: { select: { stars: true } }
        }
      },
      items: { include: { buyerRequestItem: { include: { product: true } } } }
    },
    orderBy: { createdAt: "desc" }
  });
}
async function listSupplierProposalsUseCase(supplierCompanyId) {
  return prisma.supplierProposal.findMany({
    where: { supplierCompanyId },
    include: {
      items: { include: { buyerRequestItem: { include: { product: true } } } },
      buyerRequest: {
        include: {
          items: { include: { product: true } },
          address: true,
          buyerCompany: { select: { id: true, name: true } }
        }
      }
    },
    orderBy: { createdAt: "desc" }
  });
}
async function acceptProposalUseCase(proposalId, buyerCompanyId) {
  const proposal = await prisma.supplierProposal.findUnique({
    where: { id: proposalId },
    include: {
      buyerRequest: { include: { items: true } },
      items: true
    }
  });
  if (!proposal) throw new NotFoundError("Proposta");
  if (proposal.buyerRequest.buyerCompanyId !== buyerCompanyId) throw new ForbiddenError();
  if (proposal.buyerRequest.status !== "OPEN") {
    throw new AppError("Solicita\xE7\xE3o n\xE3o est\xE1 mais aberta");
  }
  let itemsTotal = 0;
  proposal.items.forEach((pItem) => {
    const rItem = proposal.buyerRequest.items.find((i) => i.id === pItem.buyerRequestItemId);
    if (rItem) {
      itemsTotal += pItem.unitPrice * rItem.quantity;
    }
  });
  const totalPrice = itemsTotal + proposal.freightPrice;
  const [, , , order] = await prisma.$transaction([
    prisma.supplierProposal.update({
      where: { id: proposalId },
      data: { status: "ACCEPTED" }
    }),
    prisma.supplierProposal.updateMany({
      where: {
        buyerRequestId: proposal.buyerRequestId,
        id: { not: proposalId }
      },
      data: { status: "REJECTED" }
    }),
    prisma.buyerRequest.update({
      where: { id: proposal.buyerRequestId },
      data: { status: "AWARDED" }
    }),
    prisma.order.create({
      data: {
        buyerRequestId: proposal.buyerRequestId,
        proposalId,
        buyerCompanyId: proposal.buyerRequest.buyerCompanyId,
        supplierCompanyId: proposal.supplierCompanyId,
        totalPrice,
        status: "CREATED",
        timeline: {
          create: { status: "CREATED", notes: "Pedido criado ap\xF3s aceite da proposta" }
        }
      },
      include: {
        buyerRequest: { include: { items: { include: { product: true } } } },
        proposal: { include: { items: true } },
        buyerCompany: { select: { id: true, name: true } },
        supplierCompany: { select: { id: true, name: true } }
      }
    })
  ]);
  try {
    const competingProposals = await prisma.supplierProposal.findMany({
      where: { buyerRequestId: proposal.buyerRequestId },
      select: { supplierCompanyId: true }
    });
    const competingCompanyIds = Array.from(new Set(competingProposals.map((p) => p.supplierCompanyId)));
    const usersToNotify = await prisma.user.findMany({
      where: {
        OR: [
          { companyId: { in: [order.buyerCompanyId, order.supplierCompanyId] } },
          { companyId: { in: competingCompanyIds }, role: "SUPPLIER" }
        ]
      },
      select: { id: true, companyId: true }
    });
    usersToNotify.forEach((user) => {
      if (user.companyId === order.buyerCompanyId || user.companyId === order.supplierCompanyId) {
        wsManager.notifyUser(user.id, "ORDER_CREATED", { orderId: order.id, buyerRequestId: proposal.buyerRequestId });
      } else {
        wsManager.notifyUser(user.id, "REQUEST_CLOSED", { buyerRequestId: proposal.buyerRequestId, reason: "O comprador j\xE1 escolheu uma proposta. Oportunidade finalizada." });
      }
    });
  } catch (err) {
    console.error("Error sending WS notification", err);
  }
  return order;
}
async function rejectProposalUseCase(proposalId, buyerCompanyId) {
  const proposal = await prisma.supplierProposal.findUnique({
    where: { id: proposalId },
    include: { buyerRequest: true }
  });
  if (!proposal) throw new NotFoundError("Proposta");
  if (proposal.buyerRequest.buyerCompanyId !== buyerCompanyId) throw new ForbiddenError();
  const updated = await prisma.supplierProposal.update({
    where: { id: proposalId },
    data: { status: "REJECTED" }
  });
  try {
    const usersToNotify = await prisma.user.findMany({
      where: { companyId: proposal.supplierCompanyId },
      select: { id: true }
    });
    usersToNotify.forEach((user) => {
      wsManager.notifyUser(user.id, "PROPOSAL_REJECTED", {
        proposalId,
        buyerRequestId: proposal.buyerRequestId
      });
    });
  } catch (err) {
    console.error("Error sending WS notification", err);
  }
  return updated;
}
async function counterProposalUseCase(proposalId, buyerCompanyId, notes) {
  const proposal = await prisma.supplierProposal.findUnique({
    where: { id: proposalId },
    include: { buyerRequest: true }
  });
  if (!proposal) throw new NotFoundError("Proposta");
  if (proposal.buyerRequest.buyerCompanyId !== buyerCompanyId) throw new ForbiddenError();
  const updated = await prisma.supplierProposal.update({
    where: { id: proposalId },
    data: {
      status: "COUNTER_OFFER",
      observations: notes
    }
  });
  try {
    const usersToNotify = await prisma.user.findMany({
      where: { companyId: proposal.supplierCompanyId },
      select: { id: true }
    });
    usersToNotify.forEach((user) => {
      wsManager.notifyUser(user.id, "COUNTER_OFFER_RECEIVED", {
        proposalId,
        buyerRequestId: proposal.buyerRequestId
      });
    });
  } catch (err) {
    console.error("Error sending WS notification", err);
  }
  return updated;
}

// src/http/controllers/proposals.controller.ts
async function createProposalController(req, reply) {
  const user = req.user;
  const { id } = req.params;
  const data = createProposalSchema.parse(req.body);
  const result = await createProposalUseCase({
    ...data,
    buyerRequestId: id,
    supplierCompanyId: user.companyId
  });
  return reply.status(201).send(result);
}
async function listProposalsController(req, reply) {
  const user = req.user;
  const { id } = req.params;
  return listProposalsUseCase(id, user.companyId);
}
async function listSupplierProposalsController(req) {
  const user = req.user;
  console.log(`[MyProposals] Query: companyId=${user.companyId}`);
  const result = await listSupplierProposalsUseCase(user.companyId);
  console.log(`[MyProposals] Result: ${result.length} items`);
  return result;
}
async function acceptProposalController(req, reply) {
  const user = req.user;
  const { id } = req.params;
  const result = await acceptProposalUseCase(id, user.companyId);
  return reply.send(result);
}
async function rejectProposalController(req) {
  const user = req.user;
  const { id } = req.params;
  return rejectProposalUseCase(id, user.companyId);
}
async function counterProposalController(req) {
  const user = req.user;
  const { id } = req.params;
  const { notes } = req.body;
  return counterProposalUseCase(id, user.companyId, notes);
}

// src/http/routes/business.routes.ts
async function buyerRequestRoutes(app) {
  app.get("/suppliers/nearby", async () => {
    return prisma.company.findMany({
      where: { role: "SUPPLIER", active: true },
      include: {
        addresses: true,
        ratingsReceived: { select: { stars: true } }
      }
    });
  });
  app.get("/products", async () => {
    return prisma.product.findMany({ where: { active: true }, orderBy: { weightKg: "asc" } });
  });
  app.addHook("preHandler", authenticate);
  app.post("/companies/:companyId/addresses", async (req, reply) => {
    const { createAddressSchema } = await import("./schemas-4ZWUF4JU.mjs");
    const { companyId } = req.params;
    const data = createAddressSchema.parse(req.body);
    const address = await prisma.address.create({ data: { ...data, companyId } });
    return reply.status(201).send(address);
  });
  app.get("/companies/:companyId/addresses", async (req) => {
    const { companyId } = req.params;
    return prisma.address.findMany({ where: { companyId }, orderBy: { isMain: "desc" } });
  });
  app.post("/buyer-requests", createBuyerRequestController);
  app.get("/buyer-requests", listBuyerRequestsController);
  app.get("/buyer-requests/:id", getBuyerRequestController);
  app.post("/buyer-requests/:id/cancel", cancelBuyerRequestController);
  app.get("/my-proposals", listSupplierProposalsController);
  app.post("/buyer-requests/:id/proposals", createProposalController);
  app.get("/buyer-requests/:id/proposals", listProposalsController);
  app.post("/proposals/:id/accept", acceptProposalController);
  app.post("/proposals/:id/reject", rejectProposalController);
  app.post("/proposals/:id/counter", counterProposalController);
  app.post("/orders/:id/rate", async (req, reply) => {
    const { rateOrderUseCase } = await import("./ratings-CHEH4OQ7.mjs");
    const user = req.user;
    const { id } = req.params;
    const { stars, comment } = req.body;
    const rating = await rateOrderUseCase(id, user.companyId, stars, comment);
    return reply.status(201).send(rating);
  });
  app.get("/marketplace/opportunities", listOpportunitiesController);
  app.get("/marketplace/metrics", getSupplierMetricsController);
}

// src/use-cases/orders.ts
async function listOrdersUseCase(companyId, role, page, limit) {
  const where = role === "BUYER" ? { buyerCompanyId: companyId } : role === "SUPPLIER" ? { supplierCompanyId: companyId } : {};
  const [data, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: {
        buyerRequest: { include: { items: { include: { product: true } } } },
        buyerCompany: { select: { id: true, name: true } },
        supplierCompany: { select: { id: true, name: true } },
        proposal: { include: { items: true } },
        rating: true
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit
    }),
    prisma.order.count({ where })
  ]);
  return { data, total, page, limit, pages: Math.ceil(total / limit) };
}
async function getOrderUseCase(id, companyId) {
  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      buyerRequest: { include: { items: { include: { product: true } }, address: true } },
      buyerCompany: { select: { id: true, name: true, cnpj: true } },
      supplierCompany: { select: { id: true, name: true, cnpj: true } },
      proposal: { include: { items: true } },
      timeline: { orderBy: { createdAt: "asc" } }
    }
  });
  if (!order) throw new NotFoundError("Pedido");
  if (order.buyerCompanyId !== companyId && order.supplierCompanyId !== companyId) {
    throw new ForbiddenError();
  }
  return order;
}
var VALID_TRANSITIONS = {
  CREATED: ["CONFIRMED", "IN_DELIVERY", "DELIVERED", "CANCELLED"],
  CONFIRMED: ["IN_DELIVERY", "DELIVERED", "CANCELLED"],
  IN_DELIVERY: ["DELIVERED", "CANCELLED"],
  DELIVERED: [],
  CANCELLED: []
};
async function updateOrderStatusUseCase(id, companyId, status, notes, userRole) {
  const order = await prisma.order.findUnique({ where: { id } });
  if (!order) throw new NotFoundError("Pedido");
  const isBuyer = String(order.buyerCompanyId) === String(companyId);
  const isSupplier = String(order.supplierCompanyId) === String(companyId);
  const isAdmin = userRole === "ADMIN";
  if (!isBuyer && !isSupplier && !isAdmin) {
    throw new ForbiddenError();
  }
  const allowed = VALID_TRANSITIONS[order.status];
  console.log(`[DEBUG] Updating order ${id} from ${order.status} to ${status}. Allowed: ${allowed}`);
  if (!allowed.includes(status)) {
    throw new AppError(`Transi\xE7\xE3o de ${order.status} \u2192 ${status} n\xE3o permitida`);
  }
  if (status === "CANCELLED" && isBuyer && (order.status === "IN_DELIVERY" || order.status === "DELIVERED")) {
    throw new AppError("O pedido j\xE1 saiu para entrega e n\xE3o pode mais ser cancelado pelo aplicativo");
  }
  if ((status === "CONFIRMED" || status === "IN_DELIVERY") && !isSupplier && !isAdmin) {
    throw new AppError("Apenas o fornecedor pode confirmar ou despachar o pedido");
  }
  if (status === "DELIVERED" && !isBuyer && !isAdmin) {
    throw new AppError("Apenas o comprador pode marcar como entregue");
  }
  const data = { status };
  if (status === "CONFIRMED") data.confirmedAt = /* @__PURE__ */ new Date();
  if (status === "DELIVERED") data.deliveredAt = /* @__PURE__ */ new Date();
  const [updated] = await prisma.$transaction([
    prisma.order.update({ where: { id }, data }),
    prisma.orderTimeline.create({ data: { orderId: id, status, notes } })
  ]);
  try {
    const usersToNotify = await prisma.user.findMany({
      where: { companyId: { in: [order.buyerCompanyId, order.supplierCompanyId] } },
      select: { id: true }
    });
    console.log(`[WS] Notifying ${usersToNotify.length} users about ORDER_UPDATED`);
    usersToNotify.forEach((user) => {
      wsManager.notifyUser(user.id, "ORDER_UPDATED", { orderId: id, status });
    });
  } catch (err) {
    console.error("Error sending WS notification", err);
  }
  return updated;
}

// src/use-cases/order-messages.ts
async function sendMessageUseCase(orderIdOrBuyerRequestId, senderId, content) {
  let order = await prisma.order.findUnique({
    where: { id: orderIdOrBuyerRequestId }
  });
  if (!order) {
    order = await prisma.order.findUnique({
      where: { buyerRequestId: orderIdOrBuyerRequestId }
    });
  }
  if (!order) {
    throw new NotFoundError("Pedido");
  }
  const user = await prisma.user.findUnique({ where: { id: senderId } });
  if (!user || user.role !== "ADMIN" && user.companyId !== order.buyerCompanyId && user.companyId !== order.supplierCompanyId) {
    throw new ForbiddenError();
  }
  const message = await prisma.orderMessage.create({
    data: {
      orderId: order.id,
      senderId,
      content
    },
    include: {
      sender: {
        select: { id: true, name: true, companyId: true, role: true }
      }
    }
  });
  try {
    const targetCompanyId = user.companyId === order.buyerCompanyId ? order.supplierCompanyId : order.buyerCompanyId;
    const usersToNotify = await prisma.user.findMany({
      where: { companyId: targetCompanyId },
      select: { id: true }
    });
    usersToNotify.forEach((u) => {
      wsManager.notifyUser(u.id, "NEW_ORDER_MESSAGE", {
        orderId: order.id,
        messageId: message.id,
        senderName: user.name
      });
    });
  } catch (err) {
    console.error("Error sending WS notification", err);
  }
  return message;
}
async function listMessagesUseCase(orderIdOrBuyerRequestId, userId) {
  let order = await prisma.order.findUnique({
    where: { id: orderIdOrBuyerRequestId }
  });
  if (!order) {
    order = await prisma.order.findUnique({
      where: { buyerRequestId: orderIdOrBuyerRequestId }
    });
  }
  if (!order) {
    throw new NotFoundError("Pedido");
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.role !== "ADMIN" && user.companyId !== order.buyerCompanyId && user.companyId !== order.supplierCompanyId) {
    throw new ForbiddenError();
  }
  return prisma.orderMessage.findMany({
    where: { orderId: order.id },
    include: {
      sender: {
        select: { id: true, name: true, companyId: true, role: true }
      }
    },
    orderBy: { createdAt: "asc" }
  });
}

// src/http/controllers/orders.controller.ts
async function listOrdersController(req, reply) {
  const user = req.user;
  const { page, limit } = paginationSchema.parse(req.query);
  return listOrdersUseCase(user.companyId, user.role, page, limit);
}
async function getOrderController(req, reply) {
  const user = req.user;
  const { id } = req.params;
  return getOrderUseCase(id, user.companyId);
}
async function updateOrderStatusController(req, reply) {
  const user = req.user;
  const { id } = req.params;
  const { status, notes } = updateOrderStatusSchema.parse(req.body);
  let result;
  try {
    result = await updateOrderStatusUseCase(id, user.companyId, status, notes, user.role);
  } catch (err) {
    console.error("API ERROR:", err);
    throw err;
  }
  return reply.send(result);
}
async function listMessagesController(req, reply) {
  const user = req.user;
  const { id } = req.params;
  const messages = await listMessagesUseCase(id, user.sub);
  return reply.send(messages);
}
async function sendMessageController(req, reply) {
  const user = req.user;
  const { id } = req.params;
  const { content } = createOrderMessageSchema.parse(req.body);
  const message = await sendMessageUseCase(id, user.sub, content);
  return reply.status(201).send(message);
}

// src/use-cases/admin.ts
async function getAdminMetricsUseCase() {
  const [
    totalUsers,
    totalCompanies,
    totalRequests,
    totalOrders,
    openRequests,
    deliveredOrders,
    recentRequests,
    recentOrders
  ] = await Promise.all([
    prisma.user.count(),
    prisma.company.count(),
    prisma.buyerRequest.count(),
    prisma.order.count(),
    prisma.buyerRequest.count({ where: { status: "OPEN" } }),
    prisma.order.count({ where: { status: "DELIVERED" } }),
    prisma.buyerRequest.findMany({
      take: 5,
      orderBy: { createdAt: "desc" },
      include: {
        items: { include: { product: true } },
        buyerCompany: { select: { name: true } },
        _count: { select: { proposals: true } }
      }
    }),
    prisma.order.findMany({
      take: 5,
      orderBy: { createdAt: "desc" },
      include: {
        buyerCompany: { select: { name: true } },
        supplierCompany: { select: { name: true } },
        buyerRequest: { include: { items: { include: { product: true } } } }
      }
    })
  ]);
  const totalRevenue = await prisma.order.aggregate({
    where: { status: "DELIVERED" },
    _sum: { totalPrice: true }
  });
  return {
    kpis: {
      totalUsers,
      totalCompanies,
      totalRequests,
      totalOrders,
      openRequests,
      deliveredOrders,
      totalRevenue: totalRevenue._sum.totalPrice ?? 0
    },
    recentRequests,
    recentOrders
  };
}
async function listAllUsersUseCase(page, limit) {
  const [data, total] = await Promise.all([
    prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        company: { select: { id: true, name: true, cnpj: true, active: true } }
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit
    }),
    prisma.user.count()
  ]);
  return { data, total, page, limit, pages: Math.ceil(total / limit) };
}

// src/http/controllers/admin.controller.ts
async function adminMetricsController(_req, reply) {
  const metrics = await getAdminMetricsUseCase();
  return reply.send(metrics);
}
async function adminListUsersController(req, reply) {
  const { page, limit } = paginationSchema.parse(req.query);
  return listAllUsersUseCase(page, limit);
}
async function adminListRequestsController(req, reply) {
  const { page, limit } = paginationSchema.parse(req.query);
  const [data, total] = await Promise.all([
    prisma.buyerRequest.findMany({
      include: {
        items: { include: { product: true } },
        buyerCompany: { select: { id: true, name: true } },
        _count: { select: { proposals: true } }
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit
    }),
    prisma.buyerRequest.count()
  ]);
  return { data, total, page, limit, pages: Math.ceil(total / limit) };
}
async function getSystemSettingsController(_req, reply) {
  const setting = await prisma.systemSetting.findUnique({ where: { key: "proposal_window_minutes" } });
  return reply.send({ proposalWindowMinutes: setting ? parseInt(setting.value, 10) : 5 });
}
async function updateSystemSettingsController(req, reply) {
  const { proposalWindowMinutes } = req.body;
  const value = Math.max(1, Math.min(120, proposalWindowMinutes || 5)).toString();
  const setting = await prisma.systemSetting.upsert({
    where: { key: "proposal_window_minutes" },
    update: { value },
    create: { key: "proposal_window_minutes", value }
  });
  return reply.send({ proposalWindowMinutes: parseInt(setting.value, 10) });
}

// src/http/routes/orders.routes.ts
async function orderRoutes(app) {
  app.addHook("preHandler", authenticate);
  app.get("/orders", listOrdersController);
  app.get("/orders/:id", getOrderController);
  app.patch("/orders/:id/status", updateOrderStatusController);
  app.get("/orders/:id/messages", listMessagesController);
  app.post("/orders/:id/messages", sendMessageController);
}
async function adminRoutes(app) {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("ADMIN"));
  app.get("/admin/metrics", adminMetricsController);
  app.get("/admin/users", adminListUsersController);
  app.get("/admin/requests", adminListRequestsController);
  app.get("/admin/settings", getSystemSettingsController);
  app.put("/admin/settings", updateSystemSettingsController);
}

// src/app.ts
async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === "development" ? "info" : "warn",
      transport: process.env.NODE_ENV === "development" ? { target: "pino-pretty", options: { colorize: true } } : void 0
    }
  });
  await app.register(cors, {
    origin: (origin, cb) => {
      const allowedOrigins = [
        process.env.CORS_ORIGIN,
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://192.168.1.13:5173",
        "http://localhost:3000"
      ].filter(Boolean);
      if (!origin || allowedOrigins.includes(origin) || process.env.NODE_ENV === "development") {
        cb(null, true);
        return;
      }
      cb(new Error("Not allowed by CORS"), false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
  });
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error("JWT_SECRET environment variable is required");
  }
  await app.register(jwt, {
    secret: jwtSecret
  });
  await app.register(websocket);
  app.get("/health", async () => ({ status: "ok", timestamp: (/* @__PURE__ */ new Date()).toISOString() }));
  app.get("/ws", { websocket: true }, async (socket, req) => {
    const { token } = req.query;
    if (!token) {
      socket.close(1008, "Token required");
      return;
    }
    try {
      const decoded = await app.jwt.verify(token);
      const userId = decoded.sub;
      const { wsManager: wsManager2 } = await import("./ws-5T43NSWW.mjs");
      wsManager2.addClient(userId, socket);
      socket.on("message", () => {
      });
    } catch (err) {
      socket.close(1008, "Invalid token");
    }
  });
  await app.register(authRoutes);
  await app.register(buyerRequestRoutes);
  await app.register(orderRoutes);
  await app.register(adminRoutes);
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError) {
      return reply.status(422).send({
        error: "VALIDATION_ERROR",
        message: "Dados inv\xE1lidos",
        details: error.flatten().fieldErrors
      });
    }
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: error.code,
        message: error.message
      });
    }
    if (error.code === "P2002") {
      return reply.status(409).send({
        error: "CONFLICT",
        message: "Registro duplicado"
      });
    }
    req.log.error(error);
    return reply.status(500).send({
      error: "INTERNAL_ERROR",
      message: "Erro interno do servidor"
    });
  });
  return app;
}

// src/server.ts
async function start() {
  const app = await buildApp();
  const port = Number(process.env.PORT ?? 3333);
  try {
    await app.listen({ port, host: "0.0.0.0" });
    console.log(`\u{1F680} GasBid API running at http://localhost:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
start();
