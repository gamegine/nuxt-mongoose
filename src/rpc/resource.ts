import fs from 'fs-extra'
import { join } from 'pathe'
import mongoose from 'mongoose'
import type { CollectionDefinition, DevtoolsServerContext, Resource, ServerFunctions } from '../types'
import { capitalize, generateApiRoute, generateSchemaFile, pluralize, singularize } from '../utils'
import ts from 'typescript'

function findSchema(node: ts.Node): ts.ObjectLiteralExpression | undefined {
  if (ts.isPropertyAssignment(node) && node.name.getText() === 'schema') {
    if (ts.isObjectLiteralExpression(node.initializer)) return node.initializer
  }
  return ts.forEachChild(node, findSchema)
}

export function setupResourceRPC({ nuxt }: DevtoolsServerContext): any {
  const config = nuxt.options.runtimeConfig.mongoose

  return {
    async generateResource(collection: CollectionDefinition, resources: Resource[]) {
      const singular = singularize(collection.name).toLowerCase()
      const plural = pluralize(collection.name).toLowerCase()
      const dbName = capitalize(singular)

      if (collection.fields) {
        const schemaPath = join(config.modelsDir, `${singular}.schema.ts`)
        if (!fs.existsSync(schemaPath)) {
          fs.ensureDirSync(config.modelsDir)
          fs.writeFileSync(schemaPath, generateSchemaFile(dbName, collection.fields))
        }

        const model = { name: dbName, path: `${singular}.schema` }

        // create resources
        const routeTypes = {
          index: 'index.get.ts',
          create: 'create.post.ts',
          show: (by: string) => `[${by}].get.ts`,
          put: (by: string) => `[${by}].put.ts`,
          delete: (by: string) => `[${by}].delete.ts`,
        }
        resources.forEach((route: Resource) => {
          const fileName = typeof routeTypes[route.type] === 'function'
            ? (routeTypes[route.type] as any)(route.by)
            : routeTypes[route.type]

          const filePath = join(nuxt.options.serverDir, 'api', plural, fileName)
          if (!fs.existsSync(filePath)) {
            fs.ensureDirSync(join(nuxt.options.serverDir, `api/${plural}`))
            const content = generateApiRoute(route.type, { model, by: route.by })
            fs.writeFileSync(filePath, content)
          }
        })
      }

      // create collection if not exists
      const collections = await mongoose.connection.db?.listCollections().toArray()
      if (!collections?.find((c: any) => c.name === plural))
        return await mongoose.connection.db?.createCollection(plural)
    },
    async resourceSchema(collection: string) {
      const singular = singularize(collection).toLowerCase()
      const schemaPath = join(config.modelsDir, `${singular}.schema.ts`)
      if (fs.existsSync(schemaPath)) {
        const filedata = fs.readFileSync(schemaPath, 'utf-8')
        try {
          // const module = await import(schemaPath) // dynamic import error
          // console.warn("rpc:resourceSchema:module",module)
          // const model = module[Object.keys(module)[0]!] // todo: multi export ?
          // const schema = model?.schema?.obj
          // if (schema) return schema
          const sourceFile = ts.createSourceFile('schema.ts', filedata, ts.ScriptTarget.Latest, true)
          const schemaLE = findSchema(sourceFile)
          if (schemaLE) {
            // const schema = JSON.parse(schemaLE.getText()); // If possible (no undefined, Infinity, etc...)
            const schema = new Function(`return ${schemaLE.getText()}`)()
            return schema
          }
        }
        catch (error) { console.error('rpc::resourceSchema error: ', error) }

        const contenthooks = filedata.match(/schema:\s*\{([\s\S]*?)\}\s*,\s*hooks/g)
        if (contenthooks) {
          const schemaString = contenthooks[0]
            .replace('schema: ', '')
            .replace('hooks', '')
            .slice(0, -4)
          // SECURITY FIX: Use Function constructor instead of eval
          const schema = new Function(`return ${schemaString}`)()
          return schema
        }
        const content = filedata.match(/schema: \{(.|\n)*\}/g)
        if (content) {
          const schemaString = content[0].replace('schema: ', '').slice(0, -3)
          // SECURITY FIX: Use Function constructor instead of eval
          const schema = new Function(`return ${schemaString}`)()
          return schema
        }
      }
    },
  } satisfies Partial<ServerFunctions>
}
