# Prisma one2one fix

This is a hacky tool to generate 1:1 relations on a list of models given a **prisma schema file path** and a **generated prisma client directory**, it works by editing the generated `index.d.ts` file and allowing 1:1 relations at runtime.

## Usage

### 1. Script to run after running `prisma generate`

```js
import fix from './';

fix(
    ['Lang', 'Shop', 'Price', 'Tax', 'Category'],
    './prisma/schema.prisma',
    './generated/prisma',
);
```


### 2. Usage with PrismaClient (runtime)

Given this schema:

```js
model Brand {
  id         Int         @id @default(autoincrement())
  name       String
  slug       String
  brandLangs BrandLang[]
}

model BrandLang {
  id              Int       @id @default(autoincrement())
  brandId         Int
  langId          Int
  metaTitle       String
  metaDescription String
  brands          Brand     @relation(fields: [brandId], references: [id], onDelete: NoAction, map: "brand_langs_ibfk_1")
  langs           Lang      @relation(fields: [langId], references: [id], onDelete: NoAction, map: "brand_langs_ibfk_2")

  @@unique([brandId, langId], map: "FK_brand_lang_brand_id")
  @@index([langId], map: "FK_brand_lang_lang_id")
}

model Lang {
  id                 Int                 @id @default(autoincrement())
  shortIso           String
  iso                String
  name               String
  brandLangs         BrandLang[]
}
```

We'll be able to also call `brandLang` 1:1 relation even though it's not defined in the schema (because not allowed by the prisma CLI):

```js
import { PrismaClient } from '@prisma/client';
import applyRuntimeRelationPatch from './runtime-relation-patch.js';

const prisma = new PrismaClient();

const patchFunction = applyRuntimeRelationPatch(
    ['Lang', 'Shop', 'Price', 'Tax', 'Category'],
    {
        Prisma,
    },
);

const extendedClient = patchFunction(prisma);

const brand = await extendedClient.brand.findUnique({
    include: {
        brandLang: {
            where: {
                langId: 1
            }
        }
    }
});
```

