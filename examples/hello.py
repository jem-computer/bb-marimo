import marimo

__generated_with = "0.24.2"
app = marimo.App(width="medium")


@app.cell
def _():
    import marimo as mo

    return (mo,)


@app.cell
def _(mo):
    slider = mo.ui.slider(1, 10, value=3, label="n")
    slider
    return (slider,)


@app.cell
def _(mo, slider):
    mo.md(f"""
    **{slider.value}** squared is **{slider.value ** 2}**
    """)
    return


if __name__ == "__main__":
    app.run()
