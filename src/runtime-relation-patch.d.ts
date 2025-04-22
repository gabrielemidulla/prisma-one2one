export interface VirtualRelation {
    singularKey: string;
    pluralKey: string;
    relatedModel: string;
}

export interface VirtualRelationsMap {
    [modelName: string]: VirtualRelation[];
}

export interface PrismaModule {
    Prisma: any;
}

export type PatchedPrismaClient<T> = T;

declare function applyRuntimeRelationPatch(
    RELATION_MODELS: string[],
    prismaModule: PrismaModule,
): <T>(client: T) => PatchedPrismaClient<T>;

export default applyRuntimeRelationPatch;
