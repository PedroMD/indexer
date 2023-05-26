import { Logger } from '@graphprotocol/common-ts'
import { QueryTypes, DataTypes, QueryInterface } from 'sequelize'

const MANUAL_CONSTRAINT_NAME_FRAGMENT = '_composite_manual'

interface MigrationContext {
  queryInterface: QueryInterface
  logger: Logger
  networkChainId: string
}

interface Context {
  context: MigrationContext
}

interface MigrationInput {
  table: string
  oldPrimaryKeyColumns: string[]
  newColumn: string
}

interface MigrationTarget extends MigrationInput {
  oldPrimaryKeyConstraint: string
  newPrimaryKeyConstraint: string
}

type AddColumnTarget = Pick<MigrationTarget, 'table' | 'newColumn'>

const defaults: Pick<MigrationTarget, 'newColumn'> = {
  newColumn: 'protocolNetwork',
}

const actionsTarget: AddColumnTarget = {
  table: 'Actions',
  ...defaults,
}
const indexingRulesInput: MigrationInput = {
  table: 'IndexingRules',
  oldPrimaryKeyColumns: ['identifier'],
  ...defaults,
}

const poiDisputesInput: MigrationInput = {
  table: 'POIDispute',
  oldPrimaryKeyColumns: ['allocationID'],
  ...defaults,
}

export async function up({ context }: Context): Promise<void> {
  const { queryInterface, networkChainId, logger } = context
  const m = new Migration(queryInterface, logger)

  await m.addPrimaryKeyMigration(indexingRulesInput, networkChainId)
  await m.addPrimaryKeyMigration(poiDisputesInput, networkChainId)
  await m.addColumnMigration(actionsTarget, networkChainId)
}

export async function down({ context }: Context): Promise<void> {
  const { queryInterface, logger } = context
  const m = new Migration(queryInterface, logger)

  await m.removePrimaryKeyMigration(indexingRulesInput)
  await m.removePrimaryKeyMigration(poiDisputesInput)
  await m.dropColumn(actionsTarget)
}

// Helper migration class
class Migration {
  queryInterface: QueryInterface
  logger: Logger
  constructor(queryInterface: QueryInterface, logger: Logger) {
    this.queryInterface = queryInterface
    this.logger = logger
  }

  // Main migration steps in the UP direction
  async addPrimaryKeyMigration(
    input: MigrationInput,
    networkChainId: string,
  ): Promise<void> {
    const tableExists = await this.checkTableExists(input)
    if (!tableExists) {
      return
    }

    // Infer primary key constraint names
    const target = await this.processMigrationInput(input)

    // Add protocolNetwork columns
    await this.addColumn(target)

    // Loosen constraints
    await this.removeConstraint(target)

    // Populate the `protocolNetwork` columns with the provided network ID
    await this.updateTable(target, networkChainId)

    // Restore constraints
    await this.restorePrimaryKeyConstraint(target)

    // Alter the `protocolNetwork` columns to be NOT NULL
    await this.alterColumn(target)
  }

  // Main migration steps in the DOWN direction
  async removePrimaryKeyMigration(input: MigrationInput): Promise<void> {
    // Infer primary key constraint names
    const target = await this.processMigrationInputDown(input)

    // Drop the new primary key constraint
    await this.removeNewConstraint(target)

    // Drop the new columns
    await this.dropColumn(target)

    // Restore the old primary key constraint
    await this.restoreOldPrimaryKeyConstraint(target)
  }

  // Actions follow a different path because they don't use the new
  // column as a primary key
  async addColumnMigration(
    input: AddColumnTarget,
    networkChainId: string,
  ): Promise<void> {
    // Add protocolNetwork columns
    await this.addColumn(input)

    // Populate the `protocolNetwork` columns with the provided network ID
    await this.updateTable(input, networkChainId)

    // Alter the `protocolNetwork` columns to be NOT NULL
    await this.alterColumn(input)
  }

  async checkTableExists(
    target: Pick<MigrationTarget, 'table'>,
  ): Promise<boolean> {
    this.logger.debug(`Checking if ${target.table} table exists`)
    const exists = await this.queryInterface.tableExists(target.table)
    if (exists) {
      this.logger.info(
        `${target.table} table does not exist, migration not necessary`,
      )
      return false
    }
    return true
  }

  // Only for the UP step
  async processMigrationInput(input: MigrationInput): Promise<MigrationTarget> {
    const oldPrimaryKeyConstraint = await this.getPrimaryKeyConstraintName(
      input,
    )
    const newPrimaryKeyConstraint =
      oldPrimaryKeyConstraint + MANUAL_CONSTRAINT_NAME_FRAGMENT
    return {
      ...input,
      oldPrimaryKeyConstraint,
      newPrimaryKeyConstraint,
    }
  }
  // Only for the DOWN step
  async processMigrationInputDown(
    input: MigrationInput,
  ): Promise<MigrationTarget> {
    const currentPrimaryKeyConstraint = await this.getPrimaryKeyConstraintName(
      input,
    )
    let previousPrimaryKeyConstraint
    if (currentPrimaryKeyConstraint.endsWith(MANUAL_CONSTRAINT_NAME_FRAGMENT)) {
      previousPrimaryKeyConstraint = currentPrimaryKeyConstraint.replace(
        MANUAL_CONSTRAINT_NAME_FRAGMENT,
        '',
      )
    } else {
      previousPrimaryKeyConstraint = `{input.table}_pkey`
    }

    return {
      ...input,
      newPrimaryKeyConstraint: currentPrimaryKeyConstraint,
      oldPrimaryKeyConstraint: previousPrimaryKeyConstraint,
    }
  }

  async getPrimaryKeyConstraintName(target: MigrationInput): Promise<string> {
    const result: null | { constraint?: string } =
      await this.queryInterface.sequelize.query(
        `
SELECT
      con.conname as constraint
FROM
    pg_catalog.pg_constraint con
    INNER JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid
    INNER JOIN pg_catalog.pg_namespace nsp ON nsp.oid = connamespace
WHERE
    nsp.nspname = 'public'
    AND rel.relname = :table
    AND con.contype = 'p';
`,
        {
          type: QueryTypes.SELECT,
          replacements: { table: target.table },
          plain: true,
          raw: true,
        },
      )

    if (!result || !result.constraint) {
      throw new Error(
        `Failed to infer primary key constraint name for table '${target.table}'`,
      )
    }
    return result.constraint
  }

  async addColumn(target: AddColumnTarget): Promise<void> {
    this.logger.info(
      `Add '${target.newColumn}' column to ${target.table} table`,
    )
    await this.queryInterface.addColumn(target.table, target.newColumn, {
      type: DataTypes.STRING,
      allowNull: true,
    })
  }

  async dropColumn(target: AddColumnTarget): Promise<void> {
    const tables = await this.queryInterface.showAllTables()
    if (tables.includes(target.table)) {
      this.logger.info(
        `Drop '${target.newColumn}' column from ${target.table} table`,
      )
      await this.queryInterface.removeColumn(target.table, target.newColumn)
    }
  }

  async updateTable(target: AddColumnTarget, value: string) {
    const values = { [target.newColumn]: value }
    const where = { [target.newColumn]: null }
    this.logger.info(
      `Set '${target.table}' table '${target.newColumn}' column to '${value}'`,
    )
    await this.queryInterface.bulkUpdate(target.table, values, where)
  }

  async alterColumn(target: AddColumnTarget) {
    this.logger.info(
      `Altering ${target.table} table ${target.newColumn} to be non-nullable`,
    )
    await this.queryInterface.changeColumn(target.table, target.newColumn, {
      type: DataTypes.STRING,
      allowNull: true,
    })
  }

  async removeConstraint(target: MigrationTarget) {
    this.logger.info(
      `Temporarily removing primary key constraints from ${target.table}`,
    )
    await this.queryInterface.removeConstraint(
      target.table,
      target.oldPrimaryKeyConstraint,
    )
  }

  async restorePrimaryKeyConstraint(target: MigrationTarget) {
    this.logger.info(`Restoring primary key constraints from ${target.table}`)
    await this.queryInterface.addConstraint(target.table, {
      fields: [...target.oldPrimaryKeyColumns, target.newColumn],
      type: 'primary key',
      name: target.newPrimaryKeyConstraint,
    })
  }

  // Only for the DOWN step
  async removeNewConstraint(target: MigrationTarget) {
    await this.queryInterface.removeConstraint(
      target.table,
      target.newPrimaryKeyConstraint,
    )
  }

  // Only for the DOWN step
  async restoreOldPrimaryKeyConstraint(target: MigrationTarget) {
    await this.queryInterface.addConstraint(target.table, {
      fields: target.oldPrimaryKeyColumns,
      type: 'primary key',
      name: target.oldPrimaryKeyConstraint,
    })
  }
}
