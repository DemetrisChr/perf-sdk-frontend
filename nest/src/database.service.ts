import {Injectable} from '@nestjs/common';
import {Client} from 'pg';
import {
  DatabaseCompare,
  MultipleResultsHandling,
  MergingAlgorithm,
  Metrics,
  MetricsQuery,
  Input,
  ResultType,
  HorizontalAxisDynamic,
  VerticalAxisMetric, VerticalAxisBucketsColumn
} from "./dashboard.service";
import {versionCompare} from "./versions";

export class Run {
  params: Record<string, unknown>;
  cluster: Record<string, unknown>;
  impl: Record<string, unknown>;
  workload: Record<string, unknown>;
  vars: Record<string, unknown>;
  other: string;
  id: string;
  datetime: string;

  constructor(
    params: Record<string, unknown>,
    cluster: Record<string, unknown>,
    impl: Record<string, unknown>,
    workload: Record<string, unknown>,
    vars: Record<string, unknown>,
    other: string,
    id: string,
    datetime: string,
  ) {
    this.params = params;
    this.cluster = cluster;
    this.impl = impl;
    this.workload = workload;
    this.vars = vars;
    this.other = other;
    this.id = id;
    this.datetime = datetime;
  }
}

/**
 * For when the database output is multiple buckets for each run.
 */
class RunBucketPair {
  runId: string;
  datetime: string;
  timeOffsetSecs: number;
  value: number;
  metrics?: string;

  constructor(
    runId: string,
    datetime: string,
    timeOffsetSecs: number,
    value: number,
    metrics?: string
  ) {
    this.runId = runId;
    this.datetime = datetime;
    this.timeOffsetSecs = timeOffsetSecs;
    this.value = value;
    this.metrics = metrics;
  }
}

export interface RunPlus extends Run {
  groupedBy: string; // "7.0.0-3756"
  color: string; // '#E2F0CB'
}

export class Result {
  grouping: string;
  value: number;

  constructor(grouping: string, value: number) {
    this.grouping = grouping;
    this.value = value;
  }
}

class Impl {
  language: string;
  version: string;
  semver: any;
  json: Record<string, unknown>;

  constructor(language: string, version: string, semver: any, json: Record<string, unknown>) {
    this.language = language;
    this.version = version;
    this.semver = semver;
    this.json = json;
  }
}

// This class holds the keys of the fields which runs should not have (i.e. Runs which have these fields will be exluded)
// Currently we use the value `null' to mark fields that should be excluded. This could change in the future. 
class ExcludedDatabaseCompareFields {
  // An array containing the names of the cluster fields to be excluded
  cluster?: Array<string>;

  // An array containing the names of the implementation fields to be excluded
  impl?: Array<string>;

  // An array containing the names of the workload fields ot be excluded
  workload?: Array<string>;

  // An array containing the names of the variables to be excluded
  vars?: Array<string>;
}

@Injectable()
export class DatabaseService {
  constructor(private client: Client) {}

  /**
   * Used for both the Simplified and Full graphs.
   */
  async getRuns(compare: DatabaseCompare, groupBy: string): Promise<Array<Run>> {
    console.info("Database Compare Vars = " + compare.vars)

    let excludedFields = this.findAndRemoveExcluded(compare);

    const st = `SELECT
                        params as params,
                        params->'cluster' as cluster,
                        params->'impl' as impl,
                        params->'workload' as workload,
                        params->'vars' as vars,
                        params->'other' as other,
                        id as run_id,
                        datetime
                      FROM runs
                      where (params) @>
                        ('${JSON.stringify(
                          compare, null, 2
                        )}'::jsonb #- '${groupBy}')`;
    console.info(st);
    const rows = await this.client.query(st);
    let runs = rows.map((x) => {
      return new Run(
          x.params,
          x.cluster,
          x.impl,
          x.workload,
          x.vars,
          x.other,
          x.run_id,
          x.datetime,
      );
    });

    return runs.filter((x) => {return !this.containsExcludedFields(x, excludedFields)});
  }

  async getRunsById(runIds: Array<string>): Promise<Array<Run>> {
    const st = `SELECT
                        params as params,
                        params->'cluster' as cluster,
                        params->'impl' as impl,
                        params->'workload' as workload,
                        params->'vars' as vars,
                        params->'other' as other,
                        id as run_id,
                        datetime
                      FROM runs
                WHERE id in ('${runIds.join("','")}')`;
    console.info(st);
    const result = await this.client.query(st);
    return result.map((x) => {
      return new Run(
          x.params,
          x.cluster,
          x.impl,
          x.workload,
          x.vars,
          x.other,
          x.run_id,
          x.datetime,
      );
    });
  }

  /**
   * Returns all runs that match `runIds`, together with the bucket data for each.
   * Used for building the Full line graph.
   * `input.databaseCompare` is NOT used here.
   */
  async getRunsWithBuckets(
    runIds: Array<string>,
    input: Input,
    yAxis: VerticalAxisBucketsColumn): Promise<Array<RunBucketPair>> {
    let st;
    let includeMetrics = input.includeMetrics
    if (input.bucketiseSeconds > 1) {
      // Not sure how to group the metrics, would require some complex JSON processing
      includeMetrics = false
      const mergingOp = this.mapMerging(input.mergingType)
      st = `
        SELECT buckets.run_id,
               time_bucket('${input.bucketiseSeconds} seconds', time) as datetime,
               min(buckets.time_offset_secs)                     as time_offset_secs,
               ${mergingOp}(${yAxis.column}) as value 
               ${includeMetrics ? `, metrics.metrics` : ""}
        FROM buckets
          ${includeMetrics ? "LEFT OUTER JOIN metrics ON buckets.run_id = metrics.run_id AND buckets.time_offset_secs = metrics.time_offset_secs" : ""}
        WHERE buckets.run_id in ('${runIds.join("','")}')
          AND buckets.time_offset_secs >= ${input.trimmingSeconds}
        GROUP BY run_id, datetime
        ORDER BY datetime ASC;`
    }
    else {
      st = `
        SELECT buckets.run_id,
               time as datetime,
                buckets.time_offset_secs,
               ${yAxis.column} as value 
               ${includeMetrics ? `, metrics.metrics` : ""}
        FROM buckets
          ${includeMetrics ? "LEFT OUTER JOIN metrics ON buckets.run_id = metrics.run_id AND buckets.time_offset_secs = metrics.time_offset_secs" : ""}
        WHERE buckets.run_id in ('${runIds.join("','")}')
          AND buckets.time_offset_secs >= ${input.trimmingSeconds}
        ORDER BY datetime ASC;`
    }

    console.info(st);
    const result = await this.client.query(st);
    return result.map((x) => {
      return new RunBucketPair(
        x.run_id,
        x.datetime,
        parseInt(x.time_offset_secs),
        x.value,
        x.metrics
      );
    });
  }

  async getRunsRaw(): Promise<Array<Record<string, unknown>>> {
    const st = `SELECT params::json FROM runs`;
    return await this.client.query(st);
  }

  /**
   * Given a record, it finds all entries where the value is null, removes them and returns
   * an array containing the keys of those entries
   */
  private findAndRemoveNull(record: Record<string, unknown>): Array<string> {
    let res = []
    for (let key in record) {
      if (record[key] === null) {
        res.push(key)
      }
    }
    res.forEach((key) => {delete record[key]})
    return res
  }

  /**
   * Finds and removes the fields that are required to be excluded
   */
  private findAndRemoveExcluded(compare: DatabaseCompare): ExcludedDatabaseCompareFields {
    let res = new ExcludedDatabaseCompareFields()

    if (compare?.cluster) {
      res.cluster = this.findAndRemoveNull(compare.cluster)
    }
    if (compare?.impl) {
      res.impl = this.findAndRemoveNull(compare.impl)
    }
    if (compare?.vars) {
      res.vars = this.findAndRemoveNull(compare.vars)
    }
    if (compare?.workload) {
      res.workload = this.findAndRemoveNull(compare.workload)
    }
    return res
  }

  /**
   * Checks if the given run contains any of the excluded fields
   */
  private containsExcludedFields(run: Run, excluded: ExcludedDatabaseCompareFields): boolean {
    if (excluded?.cluster && this.containsAnyKey(run.cluster, excluded.cluster)) {
      return true
    }
    if (excluded?.impl && this.containsAnyKey(run.impl, excluded.impl)) {
      return true
    }
    if (excluded?.vars && this.containsAnyKey(run.vars, excluded.vars)) {
      return true
    }
    if (excluded?.workload && this.containsAnyKey(run.workload, excluded.workload)) {
      return true
    }

    return false
  }

  /**
   * Checks if the record contains any of the keys in the given array
   */
  private containsAnyKey(record: Record<string, unknown>, keys: Array<string>) {
    return keys.some((k) => k in record)
  }

  private mapMerging(merging: MergingAlgorithm): string {
    let mergingOp;
    if (merging == MergingAlgorithm.AVERAGE) {
      mergingOp = 'avg';
    } else if (merging == MergingAlgorithm.MAXIMUM) {
      mergingOp = 'max';
    } else if (merging == MergingAlgorithm.MINIMUM) {
      mergingOp = 'min';
    } else if (merging == MergingAlgorithm.SUM) {
      mergingOp = 'sum';
    } else {
      throw new Error('Unknown merging type ' + merging);
    }
    return mergingOp;
  }

  /**
   * The Simplified display.
   */
  async getSimplifiedGraph(
    groupBy1: string,
    runIds: Array<string>,
    input: Input,
    yAxis: VerticalAxisBucketsColumn): Promise<Array<Result>> {
    const mergingOp = this.mapMerging(input.mergingType)

    let st;
    if (input.multipleResultsHandling == MultipleResultsHandling.SIDE_BY_SIDE) {
      st = `SELECT runs.id,
                   sub.value,
                   ${groupBy1} as grouping
            FROM (SELECT run_id,
                         ${mergingOp}(buckets.${yAxis.column}) as value
                  FROM buckets join runs
                  on buckets.run_id = runs.id
                  WHERE run_id in ('${runIds.join("','")}')
                    AND buckets.time_offset_secs >= ${input.trimmingSeconds}
                  GROUP BY run_id) as sub
                   JOIN runs ON sub.run_id = runs.id
            ORDER BY grouping, datetime asc`;
    } else if (input.multipleResultsHandling == MultipleResultsHandling.MERGED) {
      st = `SELECT avg(sub.value) as value,
                   ${groupBy1} as grouping
            FROM (SELECT run_id,
                        ${mergingOp}(buckets.${yAxis.column}) as value
                  FROM buckets join runs
                  on buckets.run_id = runs.id
                  WHERE run_id in ('${runIds.join("','")}')
                    AND buckets.time_offset_secs >= ${input.trimmingSeconds}
                  GROUP BY run_id) as sub
                   JOIN runs ON sub.run_id = runs.id
            GROUP BY grouping
            ORDER BY grouping`;
    } else {
      throw new Error('Unknown grouping_type ' + input.multipleResultsHandling);
    }
    console.info(st);
    const result = await this.client.query(st);
    return DatabaseService.sort(result.map((x) => new Result(x.grouping, x.value)), input)
  }

  async getSimplifiedGraphForMetric(runIds: readonly string[],
                                    hAxis: HorizontalAxisDynamic,
                                    yAxis: VerticalAxisMetric,
                                    input: Input): Promise<Array<Result>> {
    const mergingOp = this.mapMerging(input.mergingType)

    let st;
    if (input.multipleResultsHandling == MultipleResultsHandling.SIDE_BY_SIDE) {
      // Can get it working later if needed
      throw "Unsupported currently"
    } else if (input.multipleResultsHandling == MultipleResultsHandling.MERGED) {
      st = `WITH 

        /* We've already found the relevant runs */
        r AS (SELECT * FROM runs WHERE id in ('${runIds.join("','")}')),

        /* Join with metrics.  Should really be driven by hAxis but have just hardcoded it to return SDK versions for now. */
        joined AS (SELECT params::jsonb->'impl'->>'version' AS groupBy, CAST(metrics.metrics::jsonb->>'${yAxis.metric}' AS FLOAT) AS metric FROM metrics JOIN r ON metrics.run_id = r.id)

        /* Group for the h-axis */
        SELECT groupBy AS grouping, ${mergingOp}(metric) AS value FROM joined GROUP BY groupBy;
        `
    } else {
      throw new Error('Unknown grouping_type ' + input.multipleResultsHandling);
    }
    console.info(st);
    const result = await this.client.query(st);
    return DatabaseService.sort(result.map((x) => new Result(x.grouping, x.value)), input);
  }

  private static sort(results: Result[], input: Input): Result[] {
    let resultType: ResultType
    if (input.hAxis.type == 'dynamic') {
      const ha = input.hAxis as HorizontalAxisDynamic
      resultType = ha.resultType
    }

    results.sort((x, y) => {
      const a = x.grouping
      const b = y.grouping
      let out
      if (resultType == ResultType.INTEGER) {
        out = Number.parseInt(a) - Number.parseInt(b)
      }
      else if (resultType == ResultType.STRING) {
        out = (a as string).localeCompare(b as string)
      }
      else if (resultType == ResultType.VERSION_SEMVER) {
        out = versionCompare(a as string, b as string)
      }

      // console.info(`${a} vs ${b} with ${resultType} = ${out}`)

      return out
    })

    // results.forEach(v => console.info(`Post-sort: ${v.grouping} = ${v.value}`))

    return results
  }

  // cast (metrics::json->>'threadCount' as integer) > 100
  // 'Excessive thread count, max=' || max (cast (metrics::json->>'threadCount' as integer))
  async getMetricsAlerts(input: MetricsQuery, metrics: Metrics, table: string) {
    // datetime >= '2022-07-30 00:00:00.000000' below is because there was a driver bug fixed around there that was not
    // closing connections.
    const st = `select run_id,
                       datetime,
                       sub.message,
                       params::jsonb->'impl'->>'version' as version
                from
                  (
                  select run_id,
                  (${metrics.message}) as message
                  from ${table}
                  where ${metrics.whereClause}
                  group by run_id
                  ) as sub
                  join runs
                on runs.id = sub.run_id
                where params::jsonb->'impl'->>'language' = '${input.language}'
                and datetime >= '2022-07-30 00:00:00.000000'
                order by string_to_array(params::jsonb->'impl'->>'version', '.')::text[] desc;`

    console.info(st);
    const result = await this.client.query(st);
    console.info(`Got ${result.length} alerts`)
    return result.map((x) => new MetricsResult(x.run_id, x.datetime, x.message, x.version, input.language));
  }
}

class MetricsResult {
  runId: string;
  datetime: string;
  message: string;
  version: string;
  language: string;

  constructor(runId: string, datetime: string, message: string, version: string, language: string) {
    this.runId = runId;
    this.datetime = datetime;
    this.message = message;
    this.version = version;
    this.language = language;
  }
}
