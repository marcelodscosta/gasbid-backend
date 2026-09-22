import { prisma } from './src/lib/prisma';
import { hash } from 'bcryptjs';

async function main() {
  const passwordHash = await hash('123456', 8);
  const suppliers = [
    { name: 'Gás Líder', cnpj: '11111111000111', lat: -23.54, lng: -46.62 },
    { name: 'Ultra Gás Express', cnpj: '22222222000122', lat: -23.56, lng: -46.64 },
    { name: 'Blue Gas Brasil', cnpj: '33333333000133', lat: -23.53, lng: -46.65 },
    { name: 'Nacional Gás SP', cnpj: '44444444000144', lat: -23.57, lng: -46.61 },
    { name: 'Gasolina e Gás', cnpj: '55555555000155', lat: -23.55, lng: -46.60 },
  ];

  for (const s of suppliers) {
    try {
      await prisma.company.create({
        data: {
          name: s.name,
          cnpj: s.cnpj,
          role: 'SUPPLIER',
          users: {
            create: {
              name: `Admin ${s.name}`,
              email: `${s.cnpj}@gasbid.com`,
              passwordHash,
              role: 'SUPPLIER',
            }
          },
          addresses: {
            create: {
              street: 'Rua do Gás',
              number: '100',
              neighborhood: 'Centro',
              city: 'São Paulo',
              state: 'SP',
              zipCode: '01000-000',
              latitude: s.lat,
              longitude: s.lng,
              isMain: true,
            }
          }
        }
      });
      console.log(`Cadastrado: ${s.name}`);
    } catch (e) {
      console.log(`Pular ${s.name} (provavelmente já existe)`);
    }
  }
}

main().finally(() => prisma.$disconnect());
