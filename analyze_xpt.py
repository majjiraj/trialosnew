#!/usr/bin/env python3
"""
Simple XPT file analyzer for SDTM datasets
"""
import sys
import os

def analyze_xpt(file_path):
    """Analyze an XPT file and return statistics"""
    try:
        import xport
        print(f"Reading XPT file: {file_path}\n")
        lib = xport.Library.read(file_path)

        for dataset in lib.datasets:
            print(f"📊 Dataset: {dataset.name}")
            print(f"   ✓ Number of rows: {len(dataset)}")
            print(f"   ✓ Number of columns: {len(dataset.columns)}")
            print(f"   ✓ Columns: {', '.join(dataset.columns)}")
            print()

            # Show variable frequencies for key columns
            if 'AETERM' in dataset.columns:
                print("   Top Adverse Event Terms:")
                for term, count in dataset['AETERM'].value_counts().head(5).items():
                    print(f"      - {term}: {count}")
            print()

    except ImportError:
        print("❌ xport library not found. Installing...")
        os.system("pip install xport")
        analyze_xpt(file_path)
    except Exception as e:
        print(f"❌ Error reading file: {e}")
        print("\nTry installing: pip install xport pandas")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyze_xpt.py <path_to_xpt_file>")
        print("\nExample:")
        print("  python analyze_xpt.py cdisc_ae.xpt")
        sys.exit(1)

    file_path = sys.argv[1]
    if not os.path.exists(file_path):
        print(f"❌ File not found: {file_path}")
        sys.exit(1)

    analyze_xpt(file_path)
