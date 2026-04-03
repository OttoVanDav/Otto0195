import { PrismaClient, OutletType } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const orgName = "Robotech Villaggi";
  const propertyName = "Welcome Riviera d'Abruzzo";

  const org =
    (await prisma.org.findFirst({ where: { name: orgName } })) ??
    (await prisma.org.create({ data: { name: orgName } }));

  const property =
    (await prisma.property.findFirst({
      where: { orgId: org.id, name: propertyName },
      include: { warehouse: true, outlets: true },
    })) ??
    (await prisma.property.create({
      data: { orgId: org.id, name: propertyName },
      include: { warehouse: true, outlets: true },
    }));

  if (!property.warehouse) {
    await prisma.warehouse.create({
      data: { propertyId: property.id, name: "Magazzino centrale" },
    });
  }

  const outletsToEnsure = [
    { name: "Bar 1", type: OutletType.BAR },
    { name: "Bar 2", type: OutletType.BAR },
    { name: "Bar 3", type: OutletType.BAR },
    { name: "Ristorante", type: OutletType.RESTAURANT },
  ];

  for (const o of outletsToEnsure) {
    const exists = await prisma.outlet.findFirst({
      where: { propertyId: property.id, name: o.name },
    });
    if (!exists) {
      await prisma.outlet.create({
        data: { propertyId: property.id, name: o.name, type: o.type },
      });
    }
  }

  const year = new Date().getUTCFullYear();
  await prisma.fiscalYear.upsert({
    where: { orgId_year: { orgId: org.id, year } },
    update: {},
    create: {
      orgId: org.id,
      year,
      startDate: new Date(Date.UTC(year, 0, 1, 0, 0, 0)),
      endDate: new Date(Date.UTC(year, 11, 31, 23, 59, 59)),
    },
  });

  console.log("Seed OK", { org: org.name, property: property.name, year });
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => prisma.$disconnect());
