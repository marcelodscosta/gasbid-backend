// src/errors/app-error.ts
var AppError = class extends Error {
  statusCode;
  code;
  constructor(message, statusCode = 400, code = "APP_ERROR") {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.name = "AppError";
  }
};
var UnauthorizedError = class extends AppError {
  constructor(message = "N\xE3o autorizado") {
    super(message, 401, "UNAUTHORIZED");
  }
};
var ForbiddenError = class extends AppError {
  constructor(message = "Acesso negado") {
    super(message, 403, "FORBIDDEN");
  }
};
var NotFoundError = class extends AppError {
  constructor(resource = "Recurso") {
    super(`${resource} n\xE3o encontrado`, 404, "NOT_FOUND");
  }
};
var ConflictError = class extends AppError {
  constructor(message = "Conflito de dados") {
    super(message, 409, "CONFLICT");
  }
};

// src/lib/prisma.ts
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import "dotenv/config";
var adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
var prisma = new PrismaClient({
  adapter,
  log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"]
});

export {
  AppError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  prisma
};
