import {EMPTY_ARRAY, Type} from './type';
import type {Entity, EntityId} from './entity';
import {MAX_NUM_FIELDS} from './consts';
import type {Dispatcher} from './dispatcher';


interface SchemaDef<JSType> {
  type: Type<JSType> | (() => Type<any>);
  default?: JSType;
}

interface Schema {
  [prop: string]: Type<any> | (() => Type<any>) | SchemaDef<any>;
}

export type ComponentStorage = 'sparse' | 'packed' | 'compact';

export interface ComponentOptions {
  storage?: ComponentStorage;
  capacity?: number;
  initialCapacity?: number;
}

export interface Field<JSType> {
  name: string;
  type: Type<JSType>;
  default: JSType;
  seq: number;
  updateBuffer?(): void;
  clearRef?(final: boolean, targetId?: EntityId, internalIndex?: number): void;
}

export interface Component {
  __invalid?: boolean;
}

export interface ComponentType<C extends Component> {
  new(): C;
  schema?: Schema;
  options?: ComponentOptions;

  /**
   * A unique, sequential id number for this component type, assigned automatically by becsy.  It
   * will stay the same across runs as long as the list of defs used to create the world doesn't
   * change.  Feel free to use this for your own purposes but don't change it.
   */
  id?: number;

  __binding?: Binding<C>;
  __bind?(id: EntityId, writable: boolean): C;
  __allocate?(id: EntityId): C;
  __free?(id: EntityId): void;
}

export class Binding<C> {
  readonlyInstance: C;
  writableInstance: C;
  readonly shapeOffset: number;
  readonly shapeMask: number;
  readonly refFields: Field<Entity | null>[];
  trackedWrites = false;
  internallyIndexed = false;
  entityId = 0;
  index = 0;
  readonly initDefault: (component: any) => void;
  readonly init: (component: any, values: any) => void;

  constructor(
    readonly type: ComponentType<C>, readonly fields: Field<any>[], readonly dispatcher: Dispatcher,
    public capacity: number, readonly storage: ComponentStorage, readonly elastic: boolean
  ) {
    this.readonlyInstance = new type();  // eslint-disable-line new-cap
    this.writableInstance = new type();  // eslint-disable-line new-cap
    this.shapeOffset = type.id! >> 5;
    this.shapeMask = 1 << (type.id! & 31);
    this.refFields = fields.filter(field => field.type === Type.ref);
    // eslint-disable-next-line no-new-func
    this.initDefault = new Function(
      'component',
      fields
        .filter(field => field.default !== EMPTY_ARRAY)
        .map(field => `component.${field.name} = ${JSON.stringify(field.default)};`)
        .join('\n')
    ) as (component: any) => void;
    // eslint-disable-next-line no-new-func
    this.init = new Function(
      'component', 'values',
      fields
        .filter(field => field.default !== EMPTY_ARRAY)
        .map(field =>
          `component.${field.name} = values.${field.name} === undefined ?
            ${JSON.stringify(field.default)} : values.${field.name};`
        )
        .join('\n')
    ) as (component: any, values: any) => void;
  }
}


interface Storage {
  acquireIndex(id: EntityId): number;
  releaseIndex(id: EntityId): void;
}


export function checkTypeDefined(type: ComponentType<any>): void {
  if (!type.__binding) {
    throw new Error(`Component ${type.name} not defined; add to world defs`);
  }
}


class PackedStorage implements Storage {
  index: Int8Array | Int16Array | Int32Array;
  // layout: bytesPerElement, nextIndex, capacity, numSpares, ...spareIndices
  private spares: Int8Array | Int16Array | Int32Array;

  constructor(
    private readonly maxEntities: number, private readonly binding: Binding<any>,
    private readonly fields: Field<any>[]
  ) {
    this.growSpares();
    this.growCapacity();
  }

  acquireIndex(id: number): number {
    let index = this.index[id];
    if (index === -1) {
      if (this.spares[3] > 0) {
        index = this.spares[--this.spares[3] + 4];
      } else {
        if (this.spares[1] === this.spares[2]) {
          CHECK: if (!this.binding.elastic) {
            throw new Error(
              `Storage exhausted for component ${this.binding.type.name}; ` +
              `raise its capacity above ${this.binding.capacity}`);
          }
          this.binding.capacity = Math.min(this.maxEntities, this.binding.capacity * 2);
          this.growCapacity();
        }
        index = this.spares[1]++;
      }
      this.index[id] = index;
    }
    return index;
  }

  releaseIndex(id: number): void {
    DEBUG: if (this.index[id] === -1) {
      throw new Error(`Internal error, index for entity ${id} not allocated`);
    }
    if (this.spares[3] === this.spares.length - 4) this.growSpares();
    this.spares[this.spares[3]++ + 4] = this.index[id];
    this.index[id] = -1;
  }

  private growCapacity(): void {
    const capacity = this.binding.capacity;
    STATS: this.binding.dispatcher.stats.for(this.binding.type).capacity = capacity;
    const ArrayType = this.ArrayType;
    const elementSizeChanged = ArrayType.BYTES_PER_ELEMENT !== this.spares?.[0];
    if (!this.index || elementSizeChanged) {
      this.binding.dispatcher.buffers.register(
        `component.${this.binding.type.id!}.storage.index`, this.maxEntities, ArrayType,
        (index: any) => {this.index = index;}, -1
      );
    }
    if (elementSizeChanged) {
      this.binding.dispatcher.buffers.register(
        `component.${this.binding.type.id!}.storage.spares`,
        this.spares.length, ArrayType,
        this.updateSpares.bind(this)
      );
    } else {
      this.spares[2] = capacity;
    }
    if (this.binding.elastic) for (const field of this.fields) field.updateBuffer!();
  }

  private growSpares(): void {
    const maxSpares = this.spares ? Math.min(this.maxEntities, (this.spares.length - 4) * 2) : 8;
    this.binding.dispatcher.buffers.register(
      `component.${this.binding.type.id!}.storage.spares`, 4 + maxSpares, this.ArrayType,
      this.updateSpares.bind(this)
    );
  }

  private updateSpares(spares: Int8Array | Int16Array | Int32Array): void {
    spares[2] = this.binding.capacity = Math.max(this.binding.capacity, spares[2]);
    spares[0] = this.ArrayType.BYTES_PER_ELEMENT;
    this.spares = spares;
  }

  private get ArrayType() {
    const capacity = Math.max(this.spares?.[2] ?? 0, this.binding.capacity);
    return capacity < (1 << 7) ? Int8Array : capacity < (1 << 15) ? Int16Array : Int32Array;
  }
}


export function initComponent(type: ComponentType<any>, id: EntityId, values: any): void {
  CHECK: {
    checkTypeDefined(type);
    if (values !== undefined) {
      for (const key in values) {
        if (!type.schema?.[key]) {
          throw new Error(`Property ${key} not defined for component ${type.name}`);
        }
      }
    }
  }
  const component = type.__allocate!(id);
  if (values) {
    type.__binding!.init(component, values);
  } else {
    type.__binding!.initDefault(component);
  }
}


function gatherFields(type: ComponentType<any>): Field<any>[] {
  const schema = type.schema;
  const fields: Field<any>[] = [];
  if (schema) {
    let seq = 0;
    for (const name in schema) {
      let entry = schema[name];
      if (entry instanceof Type || typeof entry === 'function') entry = {type: entry};
      if (typeof entry.type === 'function') entry.type = entry.type();
      if (!('default' in entry)) entry.default = entry.type.defaultValue;
      fields.push({name, seq: seq++, type: entry.type, default: entry.default});
    }
    CHECK: if (seq > MAX_NUM_FIELDS) {
      throw new Error(`Component ${type.name} declares too many fields`);
    }
  }
  return fields;
}


export function assimilateComponentType<C>(
  typeId: number, type: ComponentType<C>, dispatcher: Dispatcher
): void {
  const fields = gatherFields(type);
  // For tag components, force sparse storage since we don't actually need to allocate anything.
  const storage =
    fields.length ? (type.options?.storage ?? dispatcher.defaultComponentStorage) : 'sparse';
  const capacity = storage === 'sparse' ?
    dispatcher.maxEntities : Math.min(dispatcher.maxEntities, type.options?.capacity ?? 0);
  const initialCapacity = type.options?.initialCapacity ?? 8;
  CHECK: {
    if (typeof type.options?.capacity !== 'undefined') {
      if (storage === 'sparse') {
        throw new Error(
          `Component type ${type.name} cannot combine custom capacity with sparse storage`
        );
      }
      if (type.options.capacity <= 0) {
        throw new Error(
          `Component type ${type.name} capacity option must be great than zero: got ${capacity}`);
      }
      if (typeof type.options.initialCapacity !== 'undefined') {
        throw new Error(
          `Component type ${type.name} cannot have both capacity and initialCapacity options`);
      }
    }
    if ((typeof process === 'undefined' || process.env.NODE_ENV !== 'test') && type.__bind) {
      throw new Error(`Component type ${type.name} is already in use in another world`);
    }
  }
  type.id = typeId;
  const binding = new Binding<C>(
    type, fields, dispatcher, capacity || initialCapacity, storage, !capacity);
  type.__binding = binding;
}

export function defineAndAllocateComponentType<C extends Component>(type: ComponentType<C>): void {
  const binding = type.__binding!;
  for (const field of binding.fields) {
    if (binding.elastic) {
      field.type.defineElastic(binding, field);
    } else {
      field.type.defineFixed(binding, field);
    }
  }

  let readonlyMaster: C, writableMaster: C;
  CHECK: {
    readonlyMaster = binding.readonlyInstance;
    writableMaster = binding.writableInstance;
    binding.readonlyInstance = Object.create(readonlyMaster);
    binding.readonlyInstance.__invalid = true;
    binding.writableInstance = Object.create(writableMaster);
    binding.writableInstance.__invalid = true;
  }

  function resetComponent(writable: boolean): void {
    if (writable) {
      binding.writableInstance.__invalid = true;
      binding.writableInstance = Object.create(writableMaster);
    } else {
      binding.readonlyInstance.__invalid = true;
      binding.readonlyInstance = Object.create(readonlyMaster);
    }
  }

  switch (binding.storage) {
    case 'sparse':
      // Inline the trivial storage manager for performance.
      STATS: binding.dispatcher.stats.for(type).capacity = binding.capacity;  // fixed
      type.__bind = (id: EntityId, writable: boolean): C => {
        binding.entityId = id;
        binding.index = id;
        CHECK: resetComponent(writable);
        return writable ? binding.writableInstance : binding.readonlyInstance;
      };
      type.__allocate = (id: EntityId): C => {
        binding.entityId = id;
        binding.index = id;
        CHECK: resetComponent(true);
        return binding.writableInstance;
      };
      break;

    case 'packed': {
      const storageManager =
        new PackedStorage(binding.dispatcher.maxEntities, binding, binding.fields);
      type.__bind = (id: EntityId, writable: boolean): C => {
        binding.entityId = id;
        binding.index = storageManager.index[id];
        DEBUG: if (binding.index === -1) {
          throw new Error(`Attempt to bind unacquired entity ${id} to ${type.name}`);
        }
        CHECK: resetComponent(writable);
        return writable ? binding.writableInstance : binding.readonlyInstance;
      };
      type.__allocate = (id: EntityId): C => {
        binding.entityId = id;
        binding.index = storageManager.acquireIndex(id);
        CHECK: resetComponent(true);
        return binding.writableInstance;
      };
      type.__free = (id: EntityId): void => {
        storageManager.releaseIndex(id);
      };
      break;
    }

    case 'compact':
      // TODO: implement compact storage type
      throw new Error('Not yet implemented');

    default:
      CHECK: throw new Error(`Invalid storage type "${binding.storage}`);
  }
}

