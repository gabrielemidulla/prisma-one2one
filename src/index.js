/**@import { VirtualRelationsMap } from './runtime-relation-patch'; */
import fs from 'fs';
import path from 'path';


/**
 * Main function to process Prisma clients.
 * @param {string[]} RELATION_MODELS - Array of relation models to process.
 * @param {string} prismaFilePath - Path to the primary .prisma schema file (e.g., store.prisma).
 * @param {string} generatedDir - Directory of the primary generated Prisma client.
 */
export default (RELATION_MODELS, prismaFilePath, generatedDir) => {
    if (!generatedDir) {
        throw new Error('generatedDir is required');
    }

    if (!prismaFilePath) {
        throw new Error('prismaFilePath is required');
    }

    // Process the primary client (e.g., store)
    processPrismaClient(RELATION_MODELS, prismaFilePath, generatedDir);
};

/**
 * Processes an individual generated Prisma client directory.
 * @param {string[]} RELATION_MODELS - Array of relation models to process.
 * @param {string} schemaPathForMap - Path to the .prisma schema file to use for identifying virtual relations.
 * @param {string} clientDir - Directory containing the specific Prisma client (index.d.ts, index.js).
 */
const processPrismaClient = (RELATION_MODELS, schemaPathForMap, clientDir) => {
    const indexDtsPath = path.resolve(clientDir, 'index.d.ts');

    console.log(`Processing Prisma client: ${clientDir} (using schema: ${schemaPathForMap})`);

    // --- Read Schema and Identify Virtual Relations ---
    let schemaContent = '';
    try {
        schemaContent = fs.readFileSync(schemaPathForMap, 'utf8');
    } catch (err) {
        console.error(`Error reading schema file ${schemaPathForMap}:`, err);
        return;
    }

    const models = (schemaContent.match(/model\s+([A-Za-z0-9_]+)\s+\{/g) || []).map(m => m.split(/\s+/)[1]);
    const virtualRelationsMap = identifyVirtualRelations(RELATION_MODELS, schemaContent, models);

    // --- Process index.d.ts --- (Type Definitions)
    if (fs.existsSync(indexDtsPath)) {
        processDtsFile(indexDtsPath, virtualRelationsMap);
    } else {
        console.error(`index.d.ts not found at ${indexDtsPath}`);
        return;
    }

    console.log(`Completed processing client: ${clientDir}`);
};

/**
 * Gets the singular form of an English word from its plural form.
 * @param {string} plural - The plural form of the word
 * @returns {string} The singular form of the word
 */
function getSingularForm(plural) {
    // No need to process if the word is already singular
    if (!plural.endsWith('s')) {
        return plural;
    }

    // Handle common irregular plural patterns
    if (plural.endsWith('ies')) {
        // Categories -> Category, Groceries -> Grocery
        return plural.slice(0, -3) + 'y';
    } else if (plural.endsWith('es') &&
        (plural.endsWith('xes') || plural.endsWith('ses') ||
            plural.endsWith('ches') || plural.endsWith('shes') ||
            plural.endsWith('zes'))) {
        // Taxes -> Tax, Boxes -> Box, Glasses -> Glass, Dishes -> Dish, etc.
        return plural.slice(0, -2);
    } else {
        // Regular plural: just remove the 's'
        return plural.slice(0, -1);
    }
}

/**
 * Identifies parent models with virtual singular relations from schema content.
 * @param {string[]} RELATION_MODELS - Array of relation models to process
 * @param {string} schemaContent
 * @param {string[]} models
 * @returns {VirtualRelationsMap}
 */
function identifyVirtualRelations(RELATION_MODELS, schemaContent, models) {
    // Initialize with explicit type to avoid type errors
    const virtualRelationsMap = /** @type {Record<string, { pluralKey: string; singularKey: string; relatedModel: string }[]>} */ ({});

    // Build regex pattern for all supported relation types
    const relationTypesPattern = RELATION_MODELS.map(model => `(\\w+${model})`).join('|');
    const relationRegex = new RegExp(`(\\w+)\\s+(${relationTypesPattern})\\[\\]`, 'g');

    let totalRelations = 0;
    let relationCounts = {};
    RELATION_MODELS.forEach(model => relationCounts[model] = 0);

    models.forEach(parentModel => {
        const modelBlockRegex = new RegExp(`model\\s+${parentModel}\\s+\\{([\\s\\S]*?)\\}`, 'g');
        const modelBlockMatch = modelBlockRegex.exec(schemaContent);
        if (modelBlockMatch) {
            const modelBody = modelBlockMatch[1];
            let relMatch;
            relationRegex.lastIndex = 0;
            while ((relMatch = relationRegex.exec(modelBody)) !== null) {
                const pluralKey = relMatch[1];
                const relatedModel = relMatch[2];  // Could be *Lang, *Shop, *Price, *Tax etc.

                // Get singular form using our helper function
                const singularKey = getSingularForm(pluralKey);

                if (!virtualRelationsMap[parentModel]) virtualRelationsMap[parentModel] = [];
                if (!virtualRelationsMap[parentModel].some(e => e.pluralKey === pluralKey)) {
                    virtualRelationsMap[parentModel].push({ pluralKey, singularKey, relatedModel });

                    totalRelations++;

                    // Count by relation type
                    for (const model of RELATION_MODELS) {
                        if (relatedModel.endsWith(model)) {
                            relationCounts[model]++;
                            break;
                        }
                    }

                    console.log(`  Found virtual relation: ${parentModel}.${singularKey} -> ${pluralKey} (${relatedModel})`);
                }
            }
        }
    });

    // Log count for each relation type
    const countDetails = RELATION_MODELS.map(model => `${relationCounts[model]} ${model}`).join(', ');
    console.log(`  Found ${totalRelations} virtual relations (${countDetails})`);
    return virtualRelationsMap;
}

/**
 * Processes the index.d.ts file.
 * @param {string} indexDtsPath
 * @param {VirtualRelationsMap} virtualRelationsMap
 */
function processDtsFile(indexDtsPath, virtualRelationsMap) {
    let dtsContent = fs.readFileSync(indexDtsPath, 'utf8');
    const originalDtsContent = dtsContent;

    // 1. Make timestamps optional in *Input types
    const inputTypeRegex = /export\s+type\s+([A-Za-z0-9_]+(?:Create|Update|CreateMany|UpdateMany)(?:Input|MutationInput))\s*=\s*\{([^}]+)\}/gs;
    dtsContent = dtsContent.replace(inputTypeRegex, (_, typeName, interfaceBody) => {
        let newBody = interfaceBody.replace(/(\s*)(createdAt)(\s*):/g, '$1$2?$3:').replace(/(\s*)(updatedAt)(\s*):/g, '$1$2?$3:');
        if (typeName.includes('Create')) {
            if (!/(?:\s|\{)createdAt\??\s*:/.test(newBody)) newBody += '\n    createdAt?: Date | string;';
            if (!/(?:\s|\{)updatedAt\??\s*:/.test(newBody)) newBody += '\n    updatedAt?: Date | string;';
        }
        return `export type ${typeName} = {${newBody}}`;
    });

    // 2. Add singular virtual relation types (for all relation types)
    for (const [parentModel, relations] of Object.entries(virtualRelationsMap)) {
        relations.forEach(({ singularKey, pluralKey, relatedModel }) => {
            const singularTypeName = relatedModel; // Either *Lang, *Shop, *Price, *Tax, etc.
            const singularArgsName = `${singularTypeName}Args`;

            // Look for patterns to derive the proper types from plural relations
            // Find the type definition for the plural relation in the include type
            const pluralIncludeTypeRegex = new RegExp(`(${pluralKey}\\??\\s*:\\s*)([^;\\n]+)`, 'g');
            let pluralIncludeType = '';

            // First search in the model include type to find the proper type for plurals
            const modelIncludeRegex = new RegExp(`export\\s+type\\s+${parentModel}Include(?:<[^>]*>)?\\s*=\\s*\\{([^}]*)\\}`, 's');
            const modelIncludeMatch = modelIncludeRegex.exec(dtsContent);

            if (modelIncludeMatch) {
                const includeBody = modelIncludeMatch[1];
                const pluralTypeMatch = pluralIncludeTypeRegex.exec(includeBody);

                if (pluralTypeMatch) {
                    pluralIncludeType = pluralTypeMatch[2].trim();
                    // Convert plural type to singular type
                    // Replace Prisma.ProductLangsArgs to Prisma.ProductLangArgs
                    pluralIncludeType = pluralIncludeType.replace(
                        new RegExp(`(Prisma\\.\\w+\\$?)${pluralKey}(Args<[^>]+>)`, 'g'),
                        `$1${singularKey}$2`
                    );
                }
            }

            // Fallback type if we couldn't determine the proper type
            const fallbackIncludeType = `boolean | ${singularArgsName}<ExtArgs>`;
            const includeType = pluralIncludeType || fallbackIncludeType;

            // Add the fields to different type definitions
            const addField = (regex, fieldDef) => {
                dtsContent = dtsContent.replace(regex, (match, start, end) =>
                    !start.includes(` ${singularKey}\??\s*:`) ? `${start}${fieldDef}${end}` : match
                );
            };

            // Main model
            addField(
                new RegExp(`(export\\s+type\\s+${parentModel}\\s*=\\s*\\{[^}]*)(\\})`, 's'),
                `\n  ${singularKey}?: ${singularTypeName} | null`
            );

            // Include type
            addField(
                new RegExp(`(export\\s+type\\s+${parentModel}Include(?:<[^>]*>)?\\s*=\\s*\\{[^}]*)(\\})`, 's'),
                `\n  ${singularKey}?: ${includeType}`
            );

            // Args type
            addField(
                new RegExp(`(export\\s+type\\s+${parentModel}Args(?:<[^>]*>)?\\s*=\\s*\\{[^}]*)(\\})`, 's'),
                `\n  ${singularKey}?: ${singularArgsName}<ExtArgs>`
            );

            // GetPayload type
            addField(
                new RegExp(`(export\\s+type\\s+${parentModel}GetPayload(?:<[^>]*>)?\\s*=\\s*\\{[^}]*)(\\})`, 's'),
                `\n  ${singularKey}?: ${singularTypeName} | null`
            );
        });
    }

    // Write if changed
    if (dtsContent !== originalDtsContent) {
        fs.writeFileSync(indexDtsPath, dtsContent, 'utf8');
        console.log(`Processed TypeScript definitions in ${indexDtsPath}`);
    } else {
        console.log(`No changes needed for TypeScript definitions in ${indexDtsPath}`);
    }
}