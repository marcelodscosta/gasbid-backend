import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
prisma.orderMessage.findMany({ include: { sender: true }, take: 2 }).then(m => console.log(JSON.stringify(m, null, 2))).finally(() => prisma.$disconnect());
