//! Shared deterministic graph builders and independent invariant checks for integration tests.
//! Inputs are small grid dimensions or chain outputs; helpers return symmetric CSR graphs and
//! validate labels, population bounds, and district connectivity without calling solver internals.

#![allow(dead_code)] // Cargo compiles this shared module once per integration-test crate.

use std::collections::VecDeque;

use recom_core::{CsrGraph, PopulationBounds};

pub fn grid_graph(width: usize, height: usize, add_diagonals: bool) -> CsrGraph {
    let mut rows = vec![Vec::<u32>::new(); width * height];
    let node = |x: usize, y: usize| y * width + x;
    for y in 0..height {
        for x in 0..width {
            if x + 1 < width {
                connect(&mut rows, node(x, y), node(x + 1, y));
            }
            if y + 1 < height {
                connect(&mut rows, node(x, y), node(x, y + 1));
            }
            if add_diagonals && x + 1 < width && y + 1 < height {
                connect(&mut rows, node(x, y), node(x + 1, y + 1));
            }
        }
    }
    graph_from_rows(rows)
}

pub fn line_graph(length: usize) -> CsrGraph {
    let mut rows = vec![Vec::<u32>::new(); length];
    for node in 0..length - 1 {
        connect(&mut rows, node, node + 1);
    }
    graph_from_rows(rows)
}

pub fn row_stripes(width: usize, height: usize, districts: u16) -> Vec<u16> {
    assert_eq!(height % districts as usize, 0);
    let rows_per_district = height / districts as usize;
    (0..height)
        .flat_map(|y| std::iter::repeat_n((y / rows_per_district) as u16, width))
        .collect()
}

pub fn assert_partition_invariants(
    graph: &CsrGraph,
    populations: &[u32],
    assignment: &[u16],
    districts: u16,
    tolerance: f64,
) {
    assert_eq!(assignment.len(), graph.node_count());
    assert!(assignment.iter().all(|district| *district < districts));
    let mut district_pops = vec![0_u64; districts as usize];
    for (node, district) in assignment.iter().enumerate() {
        district_pops[*district as usize] += u64::from(populations[node]);
    }
    let bounds = PopulationBounds::new(
        populations
            .iter()
            .map(|population| u64::from(*population))
            .sum(),
        districts,
        tolerance,
    )
    .expect("test bounds are valid");
    for district in 0..districts {
        assert!(bounds.contains(district_pops[district as usize]));
        let expected = assignment
            .iter()
            .filter(|value| **value == district)
            .count();
        assert!(expected > 0);
        let start = assignment
            .iter()
            .position(|value| *value == district)
            .expect("district has a unit");
        let mut seen = vec![false; graph.node_count()];
        let mut queue = VecDeque::from([start]);
        seen[start] = true;
        let mut visited = 0;
        while let Some(node) = queue.pop_front() {
            visited += 1;
            for &neighbor in graph.neighbors_of(node) {
                let neighbor = neighbor as usize;
                if !seen[neighbor] && assignment[neighbor] == district {
                    seen[neighbor] = true;
                    queue.push_back(neighbor);
                }
            }
        }
        assert_eq!(visited, expected);
    }
}

fn graph_from_rows(mut rows: Vec<Vec<u32>>) -> CsrGraph {
    let mut offsets = Vec::with_capacity(rows.len() + 1);
    let mut neighbors = Vec::new();
    let mut county_flags = Vec::new();
    offsets.push(0);
    for (node, row) in rows.iter_mut().enumerate() {
        row.sort_unstable();
        row.dedup();
        for neighbor in row.iter().copied() {
            neighbors.push(neighbor);
            county_flags.push(u8::from(node / 8 != neighbor as usize / 8));
        }
        offsets.push(neighbors.len() as u32);
    }
    CsrGraph::new(offsets, neighbors, county_flags, None).expect("test graph is valid")
}

fn connect(rows: &mut [Vec<u32>], a: usize, b: usize) {
    rows[a].push(b as u32);
    rows[b].push(a as u32);
}
