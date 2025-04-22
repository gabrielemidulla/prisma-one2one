/**@import { VirtualRelationsMap } from "./runtime-relation-patch" */

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
 * Generates the map of virtual relations by analyzing the database schema
 * @param {string[]} relationModels - Array of relation models to process
 * @param {object} prismaModule - Prisma module with namespace
 * @returns {VirtualRelationsMap} Map of virtual relations by model
 */
function generateRelationsMap(relationModels, prismaModule) {
    const datamodel = prismaModule.Prisma.dmmf.datamodel;
    /** @type {VirtualRelationsMap} */
    const virtualRelationsMap = {};

    // Statistics counters
    let modelsProcessed = 0;
    let relationsFound = 0;
    const relationCounts = {};
    relationModels.forEach((model) => (relationCounts[model] = 0));

    for (const model of datamodel.models) {
        const modelName = model.name;
        const relations = [];
        modelsProcessed++;

        // Search for relation fields (arrays) that match our relation models
        for (const field of model.fields) {
            // Check if it's an array field and its type ends with one of our relation models
            if (field.kind === 'object' && field.isList) {
                const fieldName = field.name;
                const fieldType = field.type;

                // Check if the field type contains one of our relation models
                const matchingModel = relationModels.find((model) =>
                    fieldType.endsWith(model)
                );

                if (matchingModel) {
                    // Get the singular key using our pluralization helper
                    const singularKey = getSingularForm(fieldName);
                    const pluralKey = fieldName;

                    // The related model is the field type (e.g., "ProductLang")
                    const relatedModel = fieldType;

                    // Add the relation to the list
                    relations.push({
                        singularKey,
                        pluralKey,
                        relatedModel
                    });

                    relationsFound++;
                    relationCounts[matchingModel]++;
                }
            }
        }

        // If we found relations for this model, add them to the map
        if (relations.length > 0) {
            virtualRelationsMap[modelName] = relations;
        }
    }

    // Format count log
    const countDetails = relationModels.map(
        (model) => `${relationCounts[model]} ${model}`
    ).join(', ');

    return virtualRelationsMap;
}

/**
 * Create a function that applies the middleware for virtual relations
 * @param {string[]} relationModels - Array of relation models to process
 * @param {object} prismaModule - Prisma module with namespace
 * @returns {function} Function that takes a Prisma client and extends it with the middleware
 */
export default function applyRuntimeRelationPatch(relationModels, prismaModule) {
    /** @type {VirtualRelationsMap} */
    const virtualRelationsMap = generateRelationsMap(relationModels, prismaModule);

    return (client) => {
        if (!client || typeof client.$use !== 'function') {
            return client;
        }

        client.$use(async (params, next) => {
            // Intercept only find operations with include
            const allowedActions = ['findUnique', 'findFirst', 'findMany', 'findUniqueOrThrow', 'findFirstOrThrow'];
            if (!allowedActions.includes(params.action) || !params.args?.include) {
                return next(params);
            }

            // Map of requested singular fields for model
            const requestedSingularFields = {};

            // Process inclusions at any level of nesting
            const processInclude = (include, modelName, includeStack = '') => {
                if (!include || typeof include !== 'object') return include;

                // Create a copy of the include object to avoid modifying the original
                const transformedInclude = { ...include };
                let modified = false;

                // Search for singular relations defined for this model
                const modelRelations = virtualRelationsMap[modelName];
                if (modelRelations && Array.isArray(modelRelations)) {
                    for (const { singularKey, pluralKey } of modelRelations) {
                        // If the include contains a singular relation
                        if (singularKey in transformedInclude) {
                            // Register this field for result transformation
                            if (!requestedSingularFields[modelName]) {
                                requestedSingularFields[modelName] = [];
                            }
                            requestedSingularFields[modelName].push(singularKey);

                            // Plural inclusion options (keep existing options or set only take: 1)
                            const includeValue = transformedInclude[singularKey];
                            const pluralOptions = typeof includeValue === 'object' && includeValue !== null
                                ? { ...includeValue, take: 1 }
                                : { take: 1 };

                            // Replace the singular relation with the plural one
                            transformedInclude[pluralKey] = pluralOptions;
                            delete transformedInclude[singularKey];
                            modified = true;

                            // Log the transformation
                            const path = includeStack ? `${includeStack}.${singularKey}` : singularKey;
                        }
                    }
                }

                // Process nested includes recursively
                for (const [key, value] of Object.entries(transformedInclude)) {
                    if (value && typeof value === 'object') {
                        // If the value is an object and has the 'include' property
                        if ('include' in value) {
                            // Determine the name of the model for this relation
                            let relatedModelName = '';

                            // Search for the related model in the dmmf
                            const targetField = (prismaModule.Prisma.dmmf?.datamodel?.models || [])
                                .find(m => m.name === modelName)?.fields
                                .find(f => f.name === key);

                            if (targetField && targetField.type) {
                                relatedModelName = targetField.type;
                            } else {
                                // Euristic attempt based on the field name
                                // For plural keys (e.g. productFeatures), try to find a singular match
                                const singularKey = getSingularForm(key);

                                // Search for a model that matches the field name (singular or plural)
                                relatedModelName = Object.keys(virtualRelationsMap).find(model =>
                                    model.toLowerCase() === key.toLowerCase() ||
                                    model.toLowerCase() === singularKey.toLowerCase()
                                ) || '';

                                // If we don't find a direct match, try with the first letter capitalized
                                if (!relatedModelName) {
                                    const capitalizedKey = key.charAt(0).toUpperCase() + key.slice(1);
                                    const capitalizedSingular = singularKey.charAt(0).toUpperCase() + singularKey.slice(1);

                                    relatedModelName = Object.keys(virtualRelationsMap).find(model =>
                                        model === capitalizedKey || model === capitalizedSingular
                                    ) || '';
                                }
                            }

                            // If we found a related model, process recursively
                            if (relatedModelName) {
                                const path = includeStack ? `${includeStack}.${key}.include` : `${key}.include`;
                                const processedInclude = processInclude(value.include, relatedModelName, path);

                                if (processedInclude !== value.include) {
                                    transformedInclude[key] = {
                                        ...value,
                                        include: processedInclude
                                    };
                                    modified = true;
                                }
                            }
                        } else if (!('select' in value)) {
                            // If it doesn't have 'include' or 'select', it might be an options object
                            // but we don't process further in these cases
                        }
                    }
                }

                return modified ? transformedInclude : include;
            };

            // Apply the inclusion transformation starting from the main model
            const originalInclude = params.args.include;
            const transformedInclude = processInclude(originalInclude, params.model);

            // If we have modified the include, update the parameters
            if (transformedInclude !== originalInclude) {
                params.args.include = transformedInclude;
            }

            // Execute the query with the updated parameters
            const result = await next(params);

            // If there are no singular fields requested or no result, return the original result
            if (Object.keys(requestedSingularFields).length === 0 || !result) {
                return result;
            }

            // Recursive function to transform results
            const transformEntity = (entity, modelName, path = '') => {
                if (!entity || typeof entity !== 'object') return entity;

                // Create a new object with the same properties
                const transformed = Array.isArray(entity)
                    ? entity.map((item, idx) => transformEntity(item, modelName, `${path}[${idx}]`))
                    : { ...entity };

                // If it's not an array, apply the transformations
                if (!Array.isArray(transformed)) {
                    const modelSingularFields = requestedSingularFields[modelName] || [];
                    for (const singularKey of modelSingularFields) {
                        // Find the corresponding relation
                        const relation = virtualRelationsMap[modelName]?.find(r => r.singularKey === singularKey);
                        if (!relation) continue;

                        const { pluralKey } = relation;

                        // If the plural field exists and contains elements
                        if (pluralKey in transformed && Array.isArray(transformed[pluralKey])) {
                            // Set the singular field to the first element of the array or null
                            transformed[singularKey] = transformed[pluralKey].length > 0
                                ? transformed[pluralKey][0]
                                : null;

                            // Delete the plural field
                            delete transformed[pluralKey];
                        } else {
                            transformed[singularKey] = null;
                        }
                    }

                    // Handle nested includes
                    for (const [key, value] of Object.entries(transformed)) {
                        if (value && typeof value === 'object') {
                            let relatedModelName = '';

                            const targetField = (prismaModule.Prisma.dmmf?.datamodel?.models || [])
                                .find(m => m.name === modelName)?.fields
                                .find(f => f.name === key);

                            if (targetField && targetField.type) {
                                relatedModelName = targetField.type;
                            } else {
                                const singularKey = getSingularForm(key);

                                relatedModelName = Object.keys(virtualRelationsMap).find(model =>
                                    model.toLowerCase() === key.toLowerCase() ||
                                    model.toLowerCase() === singularKey.toLowerCase()
                                ) || '';

                                if (!relatedModelName) {
                                    const capitalizedKey = key.charAt(0).toUpperCase() + key.slice(1);
                                    const capitalizedSingular = singularKey.charAt(0).toUpperCase() + singularKey.slice(1);

                                    relatedModelName = Object.keys(virtualRelationsMap).find(model =>
                                        model === capitalizedKey || model === capitalizedSingular
                                    ) || '';
                                }
                            }

                            if (relatedModelName) {
                                transformed[key] = transformEntity(value, relatedModelName, path ? `${path}.${key}` : key);
                            }
                        }
                    }
                }

                return transformed;
            };

            if (Array.isArray(result)) {
                return result.map((item, idx) => transformEntity(item, params.model, `[${idx}]`));
            } else {
                return transformEntity(result, params.model);
            }
        });

        return client;
    };
}

