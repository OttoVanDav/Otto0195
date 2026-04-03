ALTER TABLE "OutletProductCost"
ADD COLUMN IF NOT EXISTS "unitCostNetMin" DOUBLE PRECISION;

ALTER TABLE "OutletProductCost"
ADD COLUMN IF NOT EXISTS "unitCostNetMax" DOUBLE PRECISION;

UPDATE "OutletProductCost"
SET
  "unitCostNetMin" = COALESCE("unitCostNetMin", "unitCostNet"),
  "unitCostNetMax" = COALESCE("unitCostNetMax", "unitCostNet");

UPDATE "OutletProductCost"
SET "unitCostNet" = ("unitCostNetMin" + "unitCostNetMax") / 2.0
WHERE "unitCostNet" IS DISTINCT FROM (("unitCostNetMin" + "unitCostNetMax") / 2.0);

ALTER TABLE "OutletProductCost"
ALTER COLUMN "unitCostNetMin" SET NOT NULL;

ALTER TABLE "OutletProductCost"
ALTER COLUMN "unitCostNetMax" SET NOT NULL;
