import { Query, Schema } from 'mongoose';

/**
 * Hides soft-deleted documents (`isDeleted: true`) from every read, count,
 * update and replace query, and from aggregations.
 *
 * Note: because updates are filtered too, a soft-deleted document cannot be
 * restored through a normal query. Restore it with `{ isDeleted: true }`
 * set explicitly in the filter, or via the native collection.
 */
export const softDeletePlugin = (schema: Schema): void => {
  schema.pre(
    /^find|^update|^count|^replace/,
    { document: false, query: true },
    function (this: Query<unknown, unknown>, next) {
      this.where({ isDeleted: { $ne: true } });
      next();
    },
  );

  schema.pre('aggregate', function (next) {
    this.pipeline().unshift({ $match: { isDeleted: { $ne: true } } });
    next();
  });
};
