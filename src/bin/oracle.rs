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
    #[arg(long, default_value_t = 20_000)]
    steps: u32,
    #[arg(long, default_value_t = 0.01)]
    tolerance: f64,
    #[arg(long)]
    seed: u64,
    #[arg(long, default_value_t = 0)]
    county_surcharge: u64,
    #[arg(long, default_value_t = 10)]
    tree_attempts: u32,
}

#[derive(Debug, Serialize)]
struct OracleRecord<'a> {
    step: u32,
    cut_edges: u32,
    district_pops: &'a [u64],
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments = Arguments::parse();
    let reader = BufReader::new(File::open(&arguments.graph_json)?);
    let document: Value = serde_json::from_reader(reader)?;
    let (graph, populations, assignment, district_count) =
        parse_graph(&document, &arguments.pop_col, &arguments.assignment_col)?;
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
                    cut_edges: status.current_score.cut_edges,
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

    let mut undirected = BTreeSet::new();
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
                    undirected.insert(ordered_pair(source, target));
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
                undirected.insert(ordered_pair(source, target));
            }
        }
    }

    let mut neighbors = vec![Vec::<u32>::new(); nodes.len()];
    for (a, b) in undirected {
        neighbors[a].push(b as u32);
        neighbors[b].push(a as u32);
    }
    let mut offsets = Vec::with_capacity(nodes.len() + 1);
    let mut flattened = Vec::new();
    offsets.push(0_u32);
    for row in &mut neighbors {
        row.sort_unstable();
        flattened.extend(row.iter().copied());
        offsets.push(flattened.len() as u32);
    }
    let county_flags = vec![0_u8; flattened.len()];
    let graph = CsrGraph::new(offsets, flattened, county_flags)?;
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
