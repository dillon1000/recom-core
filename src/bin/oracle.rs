//! Runs the native ReCom implementation against a GerryChain-style node-link graph. Inputs are a
//! graph JSON path, population and assignment attribute names, and chain parameters; output is one
//! JSONL record for each accepted proposal so distributional comparisons can consume a stream.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::{BufReader, BufWriter, Write},
    path::PathBuf,
};

use clap::Parser;
use recom_core::{Chain, ChainParams, CsrGraph};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Parser)]
#[command(about = "Run recom-core against a GerryChain-format graph")]
struct Arguments {
    #[arg(long)]
    graph_json: PathBuf,
    #[arg(long)]
    pop_col: String,
    #[arg(long)]
    assignment_col: String,
    /// Optional node attribute used to derive county-crossing edges and county regions.
    #[arg(long)]
    county_col: Option<String>,
    /// Optional positive-u32 edge attribute used as shared-boundary weight.
    #[arg(long)]
    edge_weight_attr: Option<String>,
    #[arg(long, default_value_t = 100_000)]
    steps: u32,
    #[arg(long, default_value_t = 0.01)]
    tolerance: f64,
    #[arg(long)]
    seed: u64,
    /// Bounded 0–50 preference shared by county-aware proposals and optimized selection.
    #[arg(long, default_value_t = 0)]
    county_surcharge: u32,
    #[arg(long, default_value_t = 10)]
    tree_attempts: u32,
}

#[derive(Debug, Serialize)]
struct OracleRecord<'a> {
    step: u32,
    cut_edges: u32,
    weighted_cut: u64,
    county_fragments: u32,
    county_splits: u32,
    max_deviation_ppm: u64,
    district_pops: &'a [u64],
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments = Arguments::parse();
    let reader = BufReader::new(File::open(&arguments.graph_json)?);
    let document: Value = serde_json::from_reader(reader)?;
    let (graph, populations, assignment, district_count) = parse_graph(
        &document,
        &arguments.pop_col,
        &arguments.assignment_col,
        arguments.county_col.as_deref(),
        arguments.edge_weight_attr.as_deref(),
    )?;
    let mut chain = Chain::new(
        graph,
        populations,
        ChainParams {
            districts: district_count,
            seed: arguments.seed,
            pop_tolerance: arguments.tolerance,
            county_surcharge: arguments.county_surcharge,
            tree_attempts: arguments.tree_attempts,
            frozen_districts: Vec::new(),
        },
        Some(assignment),
    )?;
    let stdout = std::io::stdout();
    let mut output = BufWriter::new(stdout.lock());
    for step in 1..=arguments.steps {
        let before = chain.status().steps_accepted;
        let status = chain.step(1);
        if status.steps_accepted > before {
            serde_json::to_writer(
                &mut output,
                &OracleRecord {
                    step,
                    cut_edges: chain.cut_edge_count(),
                    weighted_cut: status.current_score.weighted_cut,
                    county_fragments: status.current_score.county_fragments,
                    county_splits: status.current_score.county_splits,
                    max_deviation_ppm: status.current_score.max_deviation_ppm,
                    district_pops: chain.district_populations(),
                },
            )?;
            output.write_all(b"\n")?;
        }
    }
    output.flush()?;
    Ok(())
}

type ParsedGraph = (CsrGraph, Vec<u32>, Vec<u16>, u16);

fn parse_graph(
    document: &Value,
    pop_column: &str,
    assignment_column: &str,
    county_column: Option<&str>,
    edge_weight_attribute: Option<&str>,
) -> Result<ParsedGraph, Box<dyn std::error::Error>> {
    let nodes = document
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or("graph JSON must contain a nodes array")?;
    if nodes.is_empty() {
        return Err("graph JSON nodes array cannot be empty".into());
    }
    let mut index_by_id = BTreeMap::new();
    let mut populations = Vec::with_capacity(nodes.len());
    let mut assignment_labels = Vec::with_capacity(nodes.len());
    let mut county_labels = Vec::with_capacity(nodes.len());
    for (index, node) in nodes.iter().enumerate() {
        let id = node.get("id").ok_or("each graph node must contain id")?;
        let id = value_key(id)?;
        if index_by_id.insert(id, index).is_some() {
            return Err("graph node ids must be unique".into());
        }
        let population_value = attribute(node, pop_column)
            .ok_or_else(|| format!("node is missing population column {pop_column}"))?;
        populations.push(parse_population(population_value)?);
        let assignment_value = attribute(node, assignment_column)
            .ok_or_else(|| format!("node is missing assignment column {assignment_column}"))?;
        assignment_labels.push(value_key(assignment_value)?);
        county_labels.push(match county_column {
            Some(column) => value_key(
                attribute(node, column)
                    .ok_or_else(|| format!("node is missing county column {column}"))?,
            )?,
            None => String::new(),
        });
    }

    let labels = assignment_labels
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .enumerate()
        .map(|(index, label)| (label, index as u16))
        .collect::<BTreeMap<_, _>>();
    if labels.len() > u16::MAX as usize {
        return Err("district count exceeds u16 capacity".into());
    }
    let assignment = assignment_labels
        .iter()
        .map(|label| labels[label])
        .collect::<Vec<_>>();

    let mut undirected = BTreeMap::<(usize, usize), u32>::new();
    if let Some(adjacency) = document.get("adjacency").and_then(Value::as_array) {
        if adjacency.len() != nodes.len() {
            return Err("adjacency array must align with nodes".into());
        }
        for (source, neighbors) in adjacency.iter().enumerate() {
            for neighbor in neighbors
                .as_array()
                .ok_or("every adjacency row must be an array")?
            {
                let id = neighbor.get("id").unwrap_or(neighbor);
                let target = *index_by_id
                    .get(&value_key(id)?)
                    .ok_or("adjacency references an unknown node id")?;
                if source != target {
                    insert_edge(
                        &mut undirected,
                        ordered_pair(source, target),
                        edge_weight(neighbor, edge_weight_attribute)?,
                    )?;
                }
            }
        }
    } else {
        let links = document
            .get("links")
            .or_else(|| document.get("edges"))
            .and_then(Value::as_array)
            .ok_or("graph JSON must contain adjacency, links, or edges")?;
        for link in links {
            let source = link.get("source").ok_or("edge is missing source")?;
            let target = link.get("target").ok_or("edge is missing target")?;
            let source = *index_by_id
                .get(&value_key(source)?)
                .ok_or("edge references an unknown source id")?;
            let target = *index_by_id
                .get(&value_key(target)?)
                .ok_or("edge references an unknown target id")?;
            if source != target {
                insert_edge(
                    &mut undirected,
                    ordered_pair(source, target),
                    edge_weight(link, edge_weight_attribute)?,
                )?;
            }
        }
    }

    let mut neighbors = vec![Vec::<(u32, u32)>::new(); nodes.len()];
    for ((a, b), weight) in undirected {
        neighbors[a].push((b as u32, weight));
        neighbors[b].push((a as u32, weight));
    }
    let mut offsets = Vec::with_capacity(nodes.len() + 1);
    let mut flattened = Vec::new();
    let mut county_flags = Vec::new();
    let mut edge_weights = Vec::new();
    offsets.push(0_u32);
    for (source, row) in neighbors.iter_mut().enumerate() {
        row.sort_unstable_by_key(|(neighbor, _)| *neighbor);
        for &(neighbor, weight) in row.iter() {
            flattened.push(neighbor);
            county_flags.push(u8::from(
                county_labels[source] != county_labels[neighbor as usize],
            ));
            edge_weights.push(weight);
        }
        offsets.push(flattened.len() as u32);
    }
    let graph = CsrGraph::new(
        offsets,
        flattened,
        county_flags,
        edge_weight_attribute.map(|_| edge_weights),
    )?;
    Ok((graph, populations, assignment, labels.len() as u16))
}

fn attribute<'a>(node: &'a Value, column: &str) -> Option<&'a Value> {
    node.get(column).or_else(|| {
        node.get("properties")
            .and_then(|properties| properties.get(column))
    })
}

fn parse_population(value: &Value) -> Result<u32, Box<dyn std::error::Error>> {
    if let Some(value) = value.as_u64() {
        return u32::try_from(value).map_err(|_| "population exceeds u32 capacity".into());
    }
    if let Some(value) = value.as_i64() {
        return u32::try_from(value)
            .map_err(|_| "population must be nonnegative and fit u32".into());
    }
    if let Some(value) = value.as_f64() {
        if value >= 0.0 && value <= u32::MAX as f64 && value.fract() == 0.0 {
            return Ok(value as u32);
        }
    }
    Err("population must be a nonnegative integer".into())
}

fn edge_weight(
    edge: &Value,
    attribute_name: Option<&str>,
) -> Result<u32, Box<dyn std::error::Error>> {
    let Some(attribute_name) = attribute_name else {
        return Ok(1);
    };
    let value = attribute(edge, attribute_name)
        .ok_or_else(|| format!("edge is missing weight attribute {attribute_name}"))?;
    let weight = parse_population(value)?;
    if weight == 0 {
        return Err("edge weights must be positive integers".into());
    }
    Ok(weight)
}

fn insert_edge(
    edges: &mut BTreeMap<(usize, usize), u32>,
    pair: (usize, usize),
    weight: u32,
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(existing) = edges.insert(pair, weight) {
        if existing != weight {
            return Err(format!(
                "reverse edge entries for {} and {} have different weights",
                pair.0, pair.1
            )
            .into());
        }
    }
    Ok(())
}

fn value_key(value: &Value) -> Result<String, Box<dyn std::error::Error>> {
    match value {
        Value::String(value) => Ok(format!("s:{value}")),
        Value::Number(value) => Ok(format!("n:{value}")),
        Value::Bool(value) => Ok(format!("b:{value}")),
        _ => Err("node ids and assignments must be strings, numbers, or booleans".into()),
    }
}

fn ordered_pair(a: usize, b: usize) -> (usize, usize) {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_optional_counties_and_symmetric_weights() {
        let document = json!({
            "nodes": [
                { "id": "a", "population": 10, "district": 1, "county": "001" },
                { "id": "b", "population": 10, "district": 1, "county": "001" },
                { "id": "c", "population": 20, "district": 2, "county": "003" }
            ],
            "adjacency": [
                [{ "id": "b", "meters": 7 }],
                [{ "id": "a", "meters": 7 }, { "id": "c", "meters": 11 }],
                [{ "id": "b", "meters": 11 }]
            ]
        });
        let (graph, populations, assignment, districts) = parse_graph(
            &document,
            "population",
            "district",
            Some("county"),
            Some("meters"),
        )
        .expect("fixture is valid");

        assert_eq!(populations, vec![10, 10, 20]);
        assert_eq!(assignment, vec![0, 0, 1]);
        assert_eq!(districts, 2);
        assert_eq!(graph.directed_edge_weights(), &[7, 7, 11, 11]);
        assert_eq!(
            graph
                .edges()
                .iter()
                .map(|edge| (edge.weight, edge.county_cross))
                .collect::<Vec<_>>(),
            vec![(7, false), (11, true)]
        );
    }

    #[test]
    fn rejects_conflicting_reverse_weights() {
        let document = json!({
            "nodes": [
                { "id": 0, "population": 10, "district": 1 },
                { "id": 1, "population": 10, "district": 2 }
            ],
            "adjacency": [
                [{ "id": 1, "meters": 7 }],
                [{ "id": 0, "meters": 8 }]
            ]
        });
        assert!(parse_graph(&document, "population", "district", None, Some("meters"),).is_err());
    }
}
