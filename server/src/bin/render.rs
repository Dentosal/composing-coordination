//! CLI: render an orders JSON file to WAV. Used for parity tests.
//!
//! Usage: render <orders.json> <out.wav> [--bpm 112] [--bars 4] [--rows-per-bar 16] [--seed 1] [--seat 0]
//!                                       [--raw]   (single pass, no loop wrap)
//! The orders file may be a single Orders object, or an array of Orders (one per seat).

use band_game::orders::Orders;
use band_game::render::{render, wav, RenderConfig, SeatPart};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        eprintln!("usage: render <orders.json> <out.wav> [--bpm N] [--bars N] [--rows-per-bar N] [--seed N] [--raw]");
        std::process::exit(2);
    }
    let mut cfg = RenderConfig { bpm: 112.0, bars: 4, rows_per_bar: 16, seed: 1 };
    let mut raw = false;
    let mut i = 2;
    while i < args.len() {
        let next = |i: usize| args.get(i + 1).expect("missing value").clone();
        match args[i].as_str() {
            "--bpm" => { cfg.bpm = next(i).parse().unwrap(); i += 1 }
            "--bars" => { cfg.bars = next(i).parse().unwrap(); i += 1 }
            "--rows-per-bar" => { cfg.rows_per_bar = next(i).parse().unwrap(); i += 1 }
            "--seed" => { cfg.seed = next(i).parse().unwrap(); i += 1 }
            "--raw" => raw = true,
            other => panic!("unknown flag {other}"),
        }
        i += 1;
    }
    let text = std::fs::read_to_string(&args[0]).expect("read orders");
    let all: Vec<Orders> = match serde_json::from_str::<Vec<Orders>>(&text) {
        Ok(v) => v,
        Err(_) => vec![serde_json::from_str::<Orders>(&text).expect("parse orders")],
    };
    let parts: Vec<SeatPart> = all.iter().enumerate().map(|(i, o)| SeatPart { seat_index: i as u32, orders: o }).collect();
    let stereo = if raw {
        render(&cfg, &[parts], 0)
    } else {
        render(&cfg, &[parts.clone(), parts], 1)
    };
    std::fs::write(&args[1], wav::encode(&stereo)).expect("write wav");
}
